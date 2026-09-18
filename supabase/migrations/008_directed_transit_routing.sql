-- ============================================================================
-- 008_directed_transit_routing.sql
-- DIRECTED TRANSIT ROUTING ENFORCEMENT (MODEL C DOMAIN CONTRACT)
--
-- Preserves:
-- 1. orders.branch_id = permanent commercial origin (IMMUTABLE)
-- 2. orders.production_branch_id = designated fulfillment workshop
-- 3. Outbound routing: Origin -> Production Workshop
-- 4. Return routing: Production Workshop -> Origin (requires prior RECEIVED outbound)
-- 5. Terminal immutability, double-dispatch lock, tenant isolation, RLS.
-- ============================================================================

-- Drop mistaken signature if created during development
DROP FUNCTION IF EXISTS create_manifest_with_orders(UUID, UUID, UUID, UUID, TEXT, TEXT, UUID[]);

-- ----------------------------------------------------------------------------
-- 1. REVISE trg_enforce_manifest_order_eligibility() TRIGGER FUNCTION
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_enforce_manifest_order_eligibility()
RETURNS TRIGGER 
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_manifest_status manifest_status_enum;
    v_manifest_org UUID;
    v_manifest_src UUID;
    v_manifest_dest UUID;
    v_order_status order_status_enum;
    v_order_org UUID;
    v_order_branch UUID;
    v_order_prod_branch UUID;
    v_latest_outbound_received TIMESTAMPTZ;
BEGIN
    -- 1. Acquire exclusive lock on target order to serialize concurrent manifest assignments
    PERFORM id FROM orders WHERE id = NEW.order_id FOR UPDATE;

    -- 2. Verify parent manifest status, tenant context, source branch, and destination branch with row lock (FOR SHARE)
    -- FOR SHARE guarantees parent cannot undergo a concurrent source branch update while item is being inserted.
    SELECT status, organization_id, source_branch_id, destination_branch_id
    INTO v_manifest_status, v_manifest_org, v_manifest_src, v_manifest_dest
    FROM transit_manifests WHERE id = NEW.manifest_id FOR SHARE;

    IF v_manifest_status NOT IN ('DRAFT', 'READY_TO_DISPATCH') THEN
        RAISE EXCEPTION 'Cannot attach order to manifest % with status %. Orders can only be attached to DRAFT or READY_TO_DISPATCH manifests.', 
            NEW.manifest_id, v_manifest_status;
    END IF;

    -- 3. Verify order eligibility, organization match, and fetch branch routing attributes
    SELECT status, organization_id, branch_id, production_branch_id 
    INTO v_order_status, v_order_org, v_order_branch, v_order_prod_branch
    FROM orders WHERE id = NEW.order_id;

    IF v_order_org <> v_manifest_org THEN
        RAISE EXCEPTION 'Cross-tenant violation: Order org % does not match manifest org %.', v_order_org, v_manifest_org;
    END IF;

    IF v_order_status IN ('CANCELLED', 'COMPLETED') THEN
        RAISE EXCEPTION 'Order % dengan status % tidak eligible untuk manifest transit.', NEW.order_id, v_order_status;
    END IF;

    -- 4. Check if order is already assigned to another ACTIVE manifest (Double-dispatch protection)
    IF EXISTS (
        SELECT 1 
        FROM transit_manifest_items tmi
        JOIN transit_manifests tm ON tm.id = tmi.manifest_id
        WHERE tmi.order_id = NEW.order_id
          AND tmi.manifest_id <> NEW.manifest_id
          AND tm.status IN ('DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT')
    ) THEN
        RAISE EXCEPTION 'Order % is already assigned to an active manifest. Duplicate assignment is strictly forbidden.', NEW.order_id;
    END IF;

    -- 5. DIRECTED ROUTE DETERMINATION & VALIDATION (Model C Contract)
    
    -- Case A: OUTBOUND ROUTE (Origin Outlet -> Production Workshop)
    IF v_manifest_src = v_order_branch THEN
        IF v_manifest_dest <> v_order_prod_branch THEN
            RAISE EXCEPTION 'Outbound route violation: Order % with production branch % cannot be dispatched to destination branch %.',
                NEW.order_id, v_order_prod_branch, v_manifest_dest;
        END IF;

        -- Re-eligibility check: cannot send outbound if already received at workshop without a return
        IF EXISTS (
            SELECT 1
            FROM transit_manifest_items tmi_out
            JOIN transit_manifests tm_out ON tm_out.id = tmi_out.manifest_id
            WHERE tmi_out.order_id = NEW.order_id
              AND tm_out.source_branch_id = v_order_branch
              AND tm_out.destination_branch_id = v_order_prod_branch
              AND tm_out.status = 'RECEIVED'
              AND tmi_out.received_status = 'RECEIVED_OK'
              AND NOT EXISTS (
                  SELECT 1
                  FROM transit_manifest_items tmi_ret
                  JOIN transit_manifests tm_ret ON tm_ret.id = tmi_ret.manifest_id
                  WHERE tmi_ret.order_id = NEW.order_id
                    AND tm_ret.source_branch_id = v_order_prod_branch
                    AND tm_ret.destination_branch_id = v_order_branch
                    AND tm_ret.status = 'RECEIVED'
                    AND tmi_ret.received_status = 'RECEIVED_OK'
                    AND tm_ret.received_at > tm_out.received_at
              )
        ) THEN
            RAISE EXCEPTION 'Outbound route violation: Order % has already been received at production branch % and has not been returned.',
                NEW.order_id, v_order_prod_branch;
        END IF;

    -- Case B: RETURN ROUTE (Production Workshop -> Origin Outlet)
    ELSIF v_manifest_src = v_order_prod_branch THEN
        IF v_manifest_dest <> v_order_branch THEN
            RAISE EXCEPTION 'Return route violation: Order % originating from branch % cannot be returned to destination branch %.',
                NEW.order_id, v_order_branch, v_manifest_dest;
        END IF;

        -- Return requires a prior Outbound manifest that was RECEIVED with RECEIVED_OK
        SELECT MAX(tm_prev.received_at)
        INTO v_latest_outbound_received
        FROM transit_manifest_items tmi_prev
        JOIN transit_manifests tm_prev ON tm_prev.id = tmi_prev.manifest_id
        WHERE tmi_prev.order_id = NEW.order_id
          AND tm_prev.source_branch_id = v_order_branch
          AND tm_prev.destination_branch_id = v_order_prod_branch
          AND tm_prev.status = 'RECEIVED'
          AND tmi_prev.received_status = 'RECEIVED_OK';

        IF v_latest_outbound_received IS NULL THEN
            RAISE EXCEPTION 'Return route violation: Order % cannot be returned from % to % because no prior RECEIVED outbound transit exists.',
                NEW.order_id, v_manifest_src, v_manifest_dest;
        END IF;

        -- Forbid duplicate return if already returned after that outbound receipt
        IF EXISTS (
            SELECT 1
            FROM transit_manifest_items tmi_ret
            JOIN transit_manifests tm_ret ON tm_ret.id = tmi_ret.manifest_id
            WHERE tmi_ret.order_id = NEW.order_id
              AND tm_ret.source_branch_id = v_order_prod_branch
              AND tm_ret.destination_branch_id = v_order_branch
              AND tm_ret.status = 'RECEIVED'
              AND tmi_ret.received_status = 'RECEIVED_OK'
              AND tm_ret.received_at >= v_latest_outbound_received
        ) THEN
            RAISE EXCEPTION 'Return route violation: Order % has already been returned to origin branch %.',
                NEW.order_id, v_order_branch;
        END IF;

    -- Case C: NEITHER OUTBOUND NOR RETURN
    ELSE
        RAISE EXCEPTION 'Cross-branch violation: Order % (branch %, production %) is not eligible for manifest route % -> %.',
            NEW.order_id, v_order_branch, v_order_prod_branch, v_manifest_src, v_manifest_dest;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_manifest_item_eligibility ON transit_manifest_items;
DROP TRIGGER IF EXISTS trg_manifest_items_eligibility ON transit_manifest_items;
CREATE TRIGGER trg_manifest_item_eligibility
    BEFORE INSERT ON transit_manifest_items
    FOR EACH ROW
    EXECUTE FUNCTION trg_enforce_manifest_order_eligibility();

-- ----------------------------------------------------------------------------
-- 2. REVISE create_manifest_with_orders() RPC (MATCHING 007 SIGNATURE & DIRECTED ROUTING)
-- ----------------------------------------------------------------------------
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
    v_ord_org UUID;
    v_ord_branch UUID;
    v_ord_prod_branch UUID;
    v_ord_status order_status_enum;
    v_latest_outbound_received TIMESTAMPTZ;
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

    -- Insert parent transit manifest
    INSERT INTO transit_manifests (
        organization_id,
        manifest_number,
        source_branch_id,
        destination_branch_id,
        driver_user_id,
        vehicle_identifier,
        notes,
        status,
        total_expected_orders,
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
        COALESCE(array_length(p_order_ids, 1), 0),
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

    -- Attach orders if provided (Canonical Lock Ordering: ascending order IDs)
    IF p_order_ids IS NOT NULL AND array_length(p_order_ids, 1) > 0 THEN
        PERFORM id 
        FROM orders 
        WHERE id = ANY(p_order_ids) 
        ORDER BY id 
        FOR UPDATE;

        -- Process each order
        FOR v_order_id IN 
            SELECT DISTINCT x AS oid FROM unnest(p_order_ids) AS x ORDER BY oid 
        LOOP
            SELECT organization_id, branch_id, production_branch_id, status
            INTO v_ord_org, v_ord_branch, v_ord_prod_branch, v_ord_status
            FROM orders WHERE id = v_order_id;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Order % tidak ditemukan.', v_order_id;
            END IF;

            IF v_ord_org <> v_org_id THEN
                RAISE EXCEPTION 'Cross-tenant violation: Order % belongs to a different organization.', v_order_id;
            END IF;

            IF v_ord_status IN ('CANCELLED', 'COMPLETED') THEN
                RAISE EXCEPTION 'Order % dengan status % tidak eligible untuk manifest transit.', 
                    v_order_id, v_ord_status;
            END IF;

            -- Check active manifest assignment
            IF EXISTS (
                SELECT 1
                FROM transit_manifest_items tmi
                JOIN transit_manifests tm ON tm.id = tmi.manifest_id
                WHERE tmi.order_id = v_order_id
                  AND tm.status IN ('DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT')
            ) THEN
                RAISE EXCEPTION 'Order % is already assigned to an active manifest. Duplicate assignment is strictly forbidden.',
                    v_order_id;
            END IF;

            -- Directed Routing Invariants
            IF p_source_branch_id = v_ord_branch THEN
                -- OUTBOUND ROUTE (Outlet -> Production)
                IF p_destination_branch_id <> v_ord_prod_branch THEN
                    RAISE EXCEPTION 'Outbound route violation: Order % with production branch % cannot be dispatched to destination branch %.',
                        v_order_id, v_ord_prod_branch, p_destination_branch_id;
                END IF;

                IF EXISTS (
                    SELECT 1
                    FROM transit_manifest_items tmi_out
                    JOIN transit_manifests tm_out ON tm_out.id = tmi_out.manifest_id
                    WHERE tmi_out.order_id = v_order_id
                      AND tm_out.source_branch_id = v_ord_branch
                      AND tm_out.destination_branch_id = v_ord_prod_branch
                      AND tm_out.status = 'RECEIVED'
                      AND tmi_out.received_status = 'RECEIVED_OK'
                      AND NOT EXISTS (
                          SELECT 1
                          FROM transit_manifest_items tmi_ret
                          JOIN transit_manifests tm_ret ON tm_ret.id = tmi_ret.manifest_id
                          WHERE tmi_ret.order_id = v_order_id
                            AND tm_ret.source_branch_id = v_ord_prod_branch
                            AND tm_ret.destination_branch_id = v_ord_branch
                            AND tm_ret.status = 'RECEIVED'
                            AND tmi_ret.received_status = 'RECEIVED_OK'
                            AND tm_ret.received_at > tm_out.received_at
                      )
                ) THEN
                    RAISE EXCEPTION 'Outbound route violation: Order % has already been received at production branch % and has not been returned.',
                        v_order_id, v_ord_prod_branch;
                END IF;

            ELSIF p_source_branch_id = v_ord_prod_branch THEN
                -- RETURN ROUTE (Production -> Outlet)
                IF p_destination_branch_id <> v_ord_branch THEN
                    RAISE EXCEPTION 'Return route violation: Order % originating from branch % cannot be returned to destination branch %.',
                        v_order_id, v_ord_branch, p_destination_branch_id;
                END IF;

                SELECT MAX(tm_prev.received_at)
                INTO v_latest_outbound_received
                FROM transit_manifest_items tmi_prev
                JOIN transit_manifests tm_prev ON tm_prev.id = tmi_prev.manifest_id
                WHERE tmi_prev.order_id = v_order_id
                  AND tm_prev.source_branch_id = v_ord_branch
                  AND tm_prev.destination_branch_id = v_ord_prod_branch
                  AND tm_prev.status = 'RECEIVED'
                  AND tmi_prev.received_status = 'RECEIVED_OK';

                IF v_latest_outbound_received IS NULL THEN
                    RAISE EXCEPTION 'Return route violation: Order % cannot be returned from % to % because no prior RECEIVED outbound transit exists.',
                        v_order_id, p_source_branch_id, p_destination_branch_id;
                END IF;

                IF EXISTS (
                    SELECT 1
                    FROM transit_manifest_items tmi_ret
                    JOIN transit_manifests tm_ret ON tm_ret.id = tmi_ret.manifest_id
                    WHERE tmi_ret.order_id = v_order_id
                      AND tm_ret.source_branch_id = v_ord_prod_branch
                      AND tm_ret.destination_branch_id = v_ord_branch
                      AND tm_ret.status = 'RECEIVED'
                      AND tmi_ret.received_status = 'RECEIVED_OK'
                      AND tm_ret.received_at >= v_latest_outbound_received
                ) THEN
                    RAISE EXCEPTION 'Return route violation: Order % has already been returned to origin branch %.',
                        v_order_id, v_ord_branch;
                END IF;

            ELSE
                RAISE EXCEPTION 'Cross-branch violation: Order % does not belong to source branch %.',
                    v_order_id, p_source_branch_id;
            END IF;

            -- Insert item (triggers will execute defense-in-depth validation)
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
