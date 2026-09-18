-- ============================================================================
-- 006_transit_parent_integrity_hardening.sql
-- LaundryFlow SaaS Phase 2 Remediation (STEP 4B.3.3):
-- Parent Source Branch Route Integrity & Manifest Deletion Guard
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. HARDEN MANIFEST STATE MACHINE & ROUTE INTEGRITY TRIGGER
-- Invariant: If a manifest has items attached, source_branch_id CANNOT be modified.
-- Prevents orphan cross-branch mismatch between parent manifest and child items.
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

    -- 2. If status has not changed, protect core identity and in-flight/parent route invariants
    IF OLD.status = NEW.status THEN
        -- Prevent altering core primary/foreign/business identity
        IF OLD.id <> NEW.id OR OLD.organization_id <> NEW.organization_id OR OLD.manifest_number <> NEW.manifest_number THEN
            RAISE EXCEPTION 'Cannot modify id, organization_id, or manifest_number of manifest %.', OLD.id;
        END IF;

        -- Prevent changing routing once dispatched
        IF OLD.status = 'IN_TRANSIT' AND (OLD.source_branch_id <> NEW.source_branch_id OR OLD.destination_branch_id <> NEW.destination_branch_id) THEN
            RAISE EXCEPTION 'Cannot alter source or destination branch of manifest % while IN_TRANSIT.', OLD.id;
        END IF;

        -- CRITICAL PARENT-CHILD INTEGRITY (O-01):
        -- If source_branch_id is changed, manifest MUST NOT have existing items attached.
        -- Any existing item would otherwise violate: item.order.branch_id == manifest.source_branch_id.
        IF OLD.source_branch_id <> NEW.source_branch_id THEN
            IF EXISTS (
                SELECT 1 FROM transit_manifest_items 
                WHERE manifest_id = OLD.id
            ) THEN
                RAISE EXCEPTION 'Cannot modify source_branch_id of manifest % while items are attached. Remove all items before changing source branch.', OLD.id;
            END IF;
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
-- 2. HARDEN CONCURRENCY: ACQUIRE SHARE LOCK ON PARENT MANIFEST DURING ITEM INSERT
-- Serializes child item insertions against concurrent parent source branch updates.
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

    -- 2. Verify parent manifest status, tenant context, and source branch with row lock (FOR SHARE)
    -- FOR SHARE guarantees parent cannot undergo a concurrent source branch update while item is being inserted.
    SELECT status, organization_id, source_branch_id 
    INTO v_manifest_status, v_manifest_org, v_manifest_source_branch
    FROM transit_manifests WHERE id = NEW.manifest_id FOR SHARE;

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
-- 3. MANIFEST DELETION GUARD TRIGGER (TERMINAL & AUDIT INTEGRITY PROTECTION)
-- Enforces: Manifests cannot be deleted once in terminal or active states.
-- In LaundryFlow SaaS ERP, numbered chain-of-custody documents must be CANCELLED,
-- never deleted, preserving the JCI audit trail.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_prevent_manifest_deletion()
RETURNS TRIGGER 
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- 1. Terminal states are historical audit records and strictly undeletable
    IF OLD.status = 'RECEIVED' THEN
        RAISE EXCEPTION 'Illegal operation: Manifest % is already RECEIVED and cannot be deleted.', OLD.id;
    ELSIF OLD.status = 'CANCELLED' THEN
        RAISE EXCEPTION 'Illegal operation: Manifest % is CANCELLED and cannot be deleted.', OLD.id;
    ELSIF OLD.status IN ('IN_TRANSIT', 'READY_TO_DISPATCH') THEN
        RAISE EXCEPTION 'Illegal operation: Manifest % is in active status % and cannot be deleted.', OLD.id, OLD.status;
    ELSE
        -- DRAFT: In LaundryFlow ERP, sequential audit trail requires cancellation rather than deletion
        RAISE EXCEPTION 'Illegal operation: Manifest % is in DRAFT status and cannot be deleted. Cancel manifest to preserve audit trail.', OLD.id;
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_manifest_deletion_guard ON transit_manifests;
CREATE TRIGGER trg_manifest_deletion_guard
    BEFORE DELETE ON transit_manifests
    FOR EACH ROW
    EXECUTE FUNCTION trg_prevent_manifest_deletion();
