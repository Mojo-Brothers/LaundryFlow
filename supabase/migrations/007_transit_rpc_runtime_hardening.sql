-- ============================================================================
-- 007_transit_rpc_runtime_hardening.sql
-- LaundryFlow SaaS: Fix PostgreSQL Runtime Set-Returning Function in Aggregate
-- Fixes: create_manifest_with_orders() unnest() syntax inside count()
-- Discovered during STEP 4B.3.4 Real PostgreSQL Runtime Verification
-- ============================================================================

CREATE OR REPLACE FUNCTION create_manifest_with_orders(
    p_manifest_number VARCHAR(50),
    p_source_branch_id UUID,
    p_destination_branch_id UUID,
    p_driver_user_id UUID,
    p_vehicle_identifier VARCHAR(60),
    p_notes TEXT,
    p_order_ids UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_org_id UUID;
    v_manifest_id UUID;
    v_order_id UUID;
BEGIN
    v_org_id := auth_org_id();
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: cannot determine organization context.';
    END IF;

    -- Verify source branch access
    IF NOT user_has_branch_access(p_source_branch_id) THEN
        RAISE EXCEPTION 'Access denied for source branch %.', p_source_branch_id;
    END IF;

    -- Disallow self-routing
    IF p_source_branch_id = p_destination_branch_id THEN
        RAISE EXCEPTION 'Source and destination branches cannot be identical (self-routing rejected).';
    END IF;

    -- Insert manifest
    INSERT INTO transit_manifests (
        organization_id,
        manifest_number,
        source_branch_id,
        destination_branch_id,
        driver_user_id,
        vehicle_identifier,
        notes,
        status,
        created_by,
        created_at
    ) VALUES (
        v_org_id,
        p_manifest_number,
        p_source_branch_id,
        p_destination_branch_id,
        p_driver_user_id,
        p_vehicle_identifier,
        p_notes,
        'DRAFT',
        auth.uid(),
        NOW()
    ) RETURNING id INTO v_manifest_id;

    -- Insert initial audit history
    INSERT INTO transit_manifest_history (
        manifest_id,
        organization_id,
        from_status,
        to_status,
        actor_id,
        notes,
        created_at
    ) VALUES (
        v_manifest_id,
        v_org_id,
        NULL,
        'DRAFT',
        auth.uid(),
        'Manifest draft dibuat oleh operator',
        NOW()
    );

    -- Attach orders if provided
    IF p_order_ids IS NOT NULL AND array_length(p_order_ids, 1) > 0 THEN
        -- Canonical Lock Ordering: Lock all requested target orders in deterministic ascending ID order
        PERFORM id 
        FROM orders 
        WHERE id = ANY(p_order_ids) 
        ORDER BY id 
        FOR UPDATE;

        -- Verify that all requested orders exist, belong to tenant, AND belong to source branch
        -- FIX: In PostgreSQL, set-returning function unnest() cannot be called inside count() aggregate.
        -- Use standard table expression: SELECT count(DISTINCT x) FROM unnest(p_order_ids) AS x.
        IF (SELECT count(DISTINCT x) FROM unnest(p_order_ids) AS x) <> (
            SELECT count(*) FROM orders 
            WHERE id = ANY(p_order_ids) 
              AND organization_id = v_org_id 
              AND branch_id = p_source_branch_id
        ) THEN
            RAISE EXCEPTION 'One or more order IDs do not exist, belong to a different organization, or do not belong to source branch %.', p_source_branch_id;
        END IF;

        -- Iterate and insert in strict canonical order
        FOR v_order_id IN 
            SELECT DISTINCT x AS oid FROM unnest(p_order_ids) AS x ORDER BY oid 
        LOOP
            INSERT INTO transit_manifest_items (
                manifest_id,
                organization_id,
                order_id,
                received_status
            ) VALUES (
                v_manifest_id,
                v_org_id,
                v_order_id,
                'EXPECTED'
            );
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'manifest_id', v_manifest_id,
        'manifest_number', p_manifest_number
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION create_manifest_with_orders(VARCHAR, UUID, UUID, UUID, VARCHAR, TEXT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_manifest_with_orders(VARCHAR, UUID, UUID, UUID, VARCHAR, TEXT, UUID[]) TO authenticated;
