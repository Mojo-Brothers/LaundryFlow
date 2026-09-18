-- ============================================================================
-- 005_transit_integrity_hardening.sql
-- LaundryFlow SaaS Phase 2 Remediation (STEP 4B.3.1):
-- Cross-Branch Order Injection Hardening & Strict Post-RECEIVED Immutability
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. HARDEN ORDER ELIGIBILITY TRIGGER (CROSS-BRANCH INJECTION PROTECTION)
-- Enforces: order.organization_id == manifest.organization_id AND order.branch_id == manifest.source_branch_id
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_enforce_manifest_order_eligibility()
RETURNS TRIGGER 
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_manifest_status manifest_status_enum;
    v_manifest_org UUID;
    v_manifest_source_branch UUID;
    v_order_status order_status_enum;
    v_order_org UUID;
    v_order_branch UUID;
BEGIN
    -- 1. Acquire exclusive lock on target order to serialize concurrent manifest assignments
    PERFORM id FROM orders WHERE id = NEW.order_id FOR UPDATE;

    -- 2. Verify parent manifest status, tenant context, and source branch
    SELECT status, organization_id, source_branch_id 
    INTO v_manifest_status, v_manifest_org, v_manifest_source_branch
    FROM transit_manifests WHERE id = NEW.manifest_id;

    IF v_manifest_status NOT IN ('DRAFT', 'READY_TO_DISPATCH') THEN
        RAISE EXCEPTION 'Cannot attach order to manifest % with status %. Orders can only be attached to DRAFT or READY_TO_DISPATCH manifests.', 
            NEW.manifest_id, v_manifest_status;
    END IF;

    -- 3. Verify order eligibility, organization match, and source branch match
    SELECT status, organization_id, branch_id 
    INTO v_order_status, v_order_org, v_order_branch
    FROM orders WHERE id = NEW.order_id;

    IF v_order_org <> v_manifest_org THEN
        RAISE EXCEPTION 'Cross-tenant violation: Order org % does not match manifest org %.', v_order_org, v_manifest_org;
    END IF;

    -- CRITICAL ENFORCEMENT: Order branch MUST match manifest source branch
    IF v_order_branch <> v_manifest_source_branch THEN
        RAISE EXCEPTION 'Cross-branch violation: Order % belongs to branch %, but manifest % source branch is %.', 
            NEW.order_id, v_order_branch, NEW.manifest_id, v_manifest_source_branch;
    END IF;

    IF v_order_status IN ('CANCELLED', 'COMPLETED') THEN
        RAISE EXCEPTION 'Order % dengan status % tidak eligible untuk manifest transit.', NEW.order_id, v_order_status;
    END IF;

    -- 4. Check if order is already assigned to another ACTIVE manifest
    IF EXISTS (
        SELECT 1 
        FROM transit_manifest_items tmi
        JOIN transit_manifests tm ON tm.id = tmi.manifest_id
        WHERE tmi.order_id = NEW.order_id
          AND tm.id <> NEW.manifest_id
          AND tm.status IN ('DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT')
    ) THEN
        RAISE EXCEPTION 'Order % sedang berada dalam manifest aktif lain dan tidak dapat diduplikasi.', NEW.order_id;
    END IF;

    -- 5. Automatically increment expected order count
    UPDATE transit_manifests 
    SET total_expected_orders = total_expected_orders + 1,
        updated_at = NOW()
    WHERE id = NEW.manifest_id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_manifest_item_eligibility ON transit_manifest_items;
CREATE TRIGGER trg_manifest_item_eligibility
    BEFORE INSERT ON transit_manifest_items
    FOR EACH ROW
    EXECUTE FUNCTION trg_enforce_manifest_order_eligibility();

-- ----------------------------------------------------------------------------
-- 2. HARDEN CREATE MANIFEST RPC (CROSS-BRANCH PRE-VALIDATION)
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
        IF (SELECT count(DISTINCT unnest(p_order_ids))) <> (
            SELECT count(*) FROM orders 
            WHERE id = ANY(p_order_ids) 
              AND organization_id = v_org_id 
              AND branch_id = p_source_branch_id
        ) THEN
            RAISE EXCEPTION 'One or more order IDs do not exist, belong to a different organization, or do not belong to source branch %.', p_source_branch_id;
        END IF;

        -- Iterate and insert in strict canonical order
        FOR v_order_id IN 
            SELECT DISTINCT unnest(p_order_ids) AS oid ORDER BY oid 
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

-- ----------------------------------------------------------------------------
-- 3. HARDEN MANIFEST-LEVEL IMMUTABILITY (RECEIVED & CANCELLED IMMUTABLE RECORD)
-- Replaces BEFORE UPDATE OF status trigger with BEFORE UPDATE ON transit_manifests
-- Blocks any field update on RECEIVED or CANCELLED manifests
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_enforce_manifest_state_machine()
RETURNS TRIGGER 
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- 1. Terminal states are strictly immutable for ANY column update
    IF OLD.status = 'RECEIVED' THEN
        RAISE EXCEPTION 'Illegal operation: Manifest % is already RECEIVED and is strictly immutable.', OLD.id;
    END IF;

    IF OLD.status = 'CANCELLED' THEN
        RAISE EXCEPTION 'Illegal operation: Manifest % is CANCELLED and is strictly immutable.', OLD.id;
    END IF;

    -- 2. If status has not changed, protect core identity and in-flight route fields
    IF OLD.status = NEW.status THEN
        -- Prevent altering core primary/foreign/business identity
        IF OLD.id <> NEW.id OR OLD.organization_id <> NEW.organization_id OR OLD.manifest_number <> NEW.manifest_number THEN
            RAISE EXCEPTION 'Cannot modify id, organization_id, or manifest_number of manifest %.', OLD.id;
        END IF;

        -- Prevent changing routing once dispatched
        IF OLD.status = 'IN_TRANSIT' AND (OLD.source_branch_id <> NEW.source_branch_id OR OLD.destination_branch_id <> NEW.destination_branch_id) THEN
            RAISE EXCEPTION 'Cannot alter source or destination branch of manifest % while IN_TRANSIT.', OLD.id;
        END IF;

        RETURN NEW;
    END IF;

    -- 3. Enforce legal forward and backward state transitions
    IF OLD.status = 'DRAFT' AND NEW.status IN ('READY_TO_DISPATCH', 'CANCELLED') THEN
        RETURN NEW;
    ELSIF OLD.status = 'READY_TO_DISPATCH' AND NEW.status IN ('IN_TRANSIT', 'DRAFT', 'CANCELLED') THEN
        RETURN NEW;
    ELSIF OLD.status = 'IN_TRANSIT' AND NEW.status = 'RECEIVED' THEN
        RETURN NEW;
    ELSE
        RAISE EXCEPTION 'Illegal manifest state transition from % to % for manifest %.', OLD.status, NEW.status, OLD.id;
    END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_manifest_state_machine ON transit_manifests;
CREATE TRIGGER trg_manifest_state_machine
    BEFORE UPDATE ON transit_manifests
    FOR EACH ROW
    EXECUTE FUNCTION trg_enforce_manifest_state_machine();

-- ----------------------------------------------------------------------------
-- 4. HARDEN ITEM-LEVEL IMMUTABILITY (RECEIVED & CANCELLED PARENT MANIFEST)
-- Blocks any item update when parent manifest is RECEIVED or CANCELLED
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_prevent_manifest_item_mutation()
RETURNS TRIGGER 
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_manifest_status manifest_status_enum;
BEGIN
    -- 1. Core composite identity keys are strictly immutable at all times
    IF OLD.manifest_id <> NEW.manifest_id OR OLD.order_id <> NEW.order_id OR OLD.organization_id <> NEW.organization_id THEN
        RAISE EXCEPTION 'Cannot alter manifest_id, order_id, or organization_id on an existing manifest item.';
    END IF;

    -- 2. Query parent manifest status
    SELECT status INTO v_manifest_status
    FROM transit_manifests 
    WHERE id = OLD.manifest_id;

    -- 3. If parent manifest is terminal, block all item updates
    IF v_manifest_status = 'RECEIVED' THEN
        RAISE EXCEPTION 'Illegal operation: Parent manifest % is already RECEIVED. Manifest items are strictly immutable.', OLD.manifest_id;
    END IF;

    IF v_manifest_status = 'CANCELLED' THEN
        RAISE EXCEPTION 'Illegal operation: Parent manifest % is CANCELLED. Manifest items cannot be modified.', OLD.manifest_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_manifest_item_mutation_lock ON transit_manifest_items;
CREATE TRIGGER trg_manifest_item_mutation_lock
    BEFORE UPDATE ON transit_manifest_items
    FOR EACH ROW
    EXECUTE FUNCTION trg_prevent_manifest_item_mutation();

-- ----------------------------------------------------------------------------
-- 5. ITEM DELETION LOCK TRIGGER (PREVENT ITEM REMOVAL OUTSIDE DRAFT)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_prevent_manifest_item_deletion()
RETURNS TRIGGER 
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_manifest_status manifest_status_enum;
BEGIN
    SELECT status INTO v_manifest_status
    FROM transit_manifests 
    WHERE id = OLD.manifest_id;

    IF v_manifest_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Cannot delete item from manifest % with status %. Items can only be removed while in DRAFT.', 
            OLD.manifest_id, v_manifest_status;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_manifest_item_delete_lock ON transit_manifest_items;
CREATE TRIGGER trg_manifest_item_delete_lock
    BEFORE DELETE ON transit_manifest_items
    FOR EACH ROW
    EXECUTE FUNCTION trg_prevent_manifest_item_deletion();
