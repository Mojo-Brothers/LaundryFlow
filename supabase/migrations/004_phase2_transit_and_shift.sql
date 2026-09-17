-- ============================================================================
-- 004_phase2_transit_and_shift.sql
-- LaundryFlow SaaS Phase 2: Multi-Outlet Transit Manifest & Cashier Shift Audit
-- (Composite Tenant Integrity, Concurrency Protection, Atomic RPCs, and Immutable Audits)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ENUM TYPES
-- ----------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE manifest_status_enum AS ENUM (
        'DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE manifest_item_status_enum AS ENUM (
        'EXPECTED', 'RECEIVED_OK', 'MISSING', 'DAMAGED', 'WRONG_BRANCH'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ----------------------------------------------------------------------------
-- 2. COMPOSITE UNIQUE CONSTRAINTS ON EXISTING TABLES
-- Required to enforce composite foreign keys (id, organization_id) at the DB engine layer
-- ----------------------------------------------------------------------------
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_branches_id_org'
    ) THEN
        ALTER TABLE branches ADD CONSTRAINT uq_branches_id_org UNIQUE (id, organization_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_users_id_org'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT uq_users_id_org UNIQUE (id, organization_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_orders_id_org'
    ) THEN
        ALTER TABLE orders ADD CONSTRAINT uq_orders_id_org UNIQUE (id, organization_id);
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. EXPAND CASHIER SHIFTS TABLE (RECONCILIATION & AUDIT INTEGRITY)
-- ----------------------------------------------------------------------------
ALTER TABLE cashier_shifts 
    ADD COLUMN IF NOT EXISTS cash_sales NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS qris_sales NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS transfer_sales NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS cash_in NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS cash_out NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS transaction_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS variance_note TEXT;

-- Enforce mandatory explanation note when cash drawer difference <> 0 upon closing
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_shift_variance_note'
    ) THEN
        ALTER TABLE cashier_shifts 
        ADD CONSTRAINT chk_shift_variance_note 
        CHECK (
            status <> 'CLOSED' OR 
            difference = 0 OR 
            (variance_note IS NOT NULL AND length(trim(variance_note)) >= 5)
        );
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4. TRANSIT MANIFESTS TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transit_manifests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    manifest_number VARCHAR(50) NOT NULL,
    source_branch_id UUID NOT NULL,
    destination_branch_id UUID NOT NULL,
    status manifest_status_enum NOT NULL DEFAULT 'DRAFT',
    driver_user_id UUID,
    vehicle_identifier VARCHAR(60),
    notes TEXT,
    discrepancy_summary TEXT,
    total_expected_orders INT NOT NULL DEFAULT 0 CHECK (total_expected_orders >= 0),
    total_received_orders INT NOT NULL DEFAULT 0 CHECK (total_received_orders >= 0),
    has_discrepancy BOOLEAN NOT NULL DEFAULT FALSE,
    created_by UUID NOT NULL,
    dispatched_by UUID,
    received_by UUID,
    cancelled_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dispatched_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT uq_manifests_id_org UNIQUE (id, organization_id),
    CONSTRAINT uq_manifests_org_number UNIQUE (organization_id, manifest_number),
    CONSTRAINT chk_manifest_different_branches CHECK (source_branch_id <> destination_branch_id),

    -- Composite Foreign Keys (Strict Cross-Tenant Enforcement)
    CONSTRAINT fk_manifest_source_branch FOREIGN KEY (source_branch_id, organization_id) 
        REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT fk_manifest_dest_branch FOREIGN KEY (destination_branch_id, organization_id) 
        REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT fk_manifest_driver FOREIGN KEY (driver_user_id, organization_id) 
        REFERENCES users(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT fk_manifest_created_by FOREIGN KEY (created_by, organization_id) 
        REFERENCES users(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT fk_manifest_dispatched_by FOREIGN KEY (dispatched_by, organization_id) 
        REFERENCES users(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT fk_manifest_received_by FOREIGN KEY (received_by, organization_id) 
        REFERENCES users(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT fk_manifest_cancelled_by FOREIGN KEY (cancelled_by, organization_id) 
        REFERENCES users(id, organization_id) ON DELETE RESTRICT
);

-- ----------------------------------------------------------------------------
-- 5. TRANSIT MANIFEST ITEMS TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transit_manifest_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    manifest_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    order_id UUID NOT NULL,
    received_status manifest_item_status_enum NOT NULL DEFAULT 'EXPECTED',
    discrepancy_notes TEXT,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_at TIMESTAMPTZ,
    inspected_by UUID,

    -- Constraints
    CONSTRAINT uq_manifest_item_order UNIQUE (manifest_id, order_id),
    
    -- Composite Foreign Keys
    CONSTRAINT fk_item_manifest FOREIGN KEY (manifest_id, organization_id) 
        REFERENCES transit_manifests(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT fk_item_order FOREIGN KEY (order_id, organization_id) 
        REFERENCES orders(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT fk_item_inspected_by FOREIGN KEY (inspected_by, organization_id) 
        REFERENCES users(id, organization_id) ON DELETE RESTRICT
);

-- ----------------------------------------------------------------------------
-- 6. TRANSIT MANIFEST HISTORY TABLE (IMMUTABLE FORENSIC AUDIT)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transit_manifest_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    manifest_id UUID NOT NULL REFERENCES transit_manifests(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    from_status manifest_status_enum,
    to_status manifest_status_enum NOT NULL,
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 7. PERFORMANCE INDEXES
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_manifests_org_status ON transit_manifests(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_manifests_source_status ON transit_manifests(source_branch_id, status);
CREATE INDEX IF NOT EXISTS idx_manifests_dest_status ON transit_manifests(destination_branch_id, status);
CREATE INDEX IF NOT EXISTS idx_manifests_driver ON transit_manifests(driver_user_id);
CREATE INDEX IF NOT EXISTS idx_manifests_created_at ON transit_manifests(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_manifest_items_manifest ON transit_manifest_items(manifest_id);
CREATE INDEX IF NOT EXISTS idx_manifest_items_order ON transit_manifest_items(order_id);
CREATE INDEX IF NOT EXISTS idx_manifest_items_status ON transit_manifest_items(received_status);

CREATE INDEX IF NOT EXISTS idx_manifest_history_manifest ON transit_manifest_history(manifest_id, created_at ASC);

-- ----------------------------------------------------------------------------
-- 8. TRIGGERS: INTEGRITY, CONCURRENCY & IMMUTABILITY
-- ----------------------------------------------------------------------------

-- A. State Machine Enforcement Trigger for Transit Manifests
CREATE OR REPLACE FUNCTION trg_enforce_manifest_state_machine()
RETURNS TRIGGER 
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- If status hasn't changed, allow update
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    -- Terminal states are strictly immutable
    IF OLD.status = 'RECEIVED' THEN
        RAISE EXCEPTION 'Illegal state transition: Manifest % is already RECEIVED and cannot be modified.', OLD.id;
    END IF;
    IF OLD.status = 'CANCELLED' THEN
        RAISE EXCEPTION 'Illegal state transition: Manifest % is CANCELLED and cannot be modified.', OLD.id;
    END IF;

    -- Enforce legal transitions
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
    BEFORE UPDATE OF status ON transit_manifests
    FOR EACH ROW
    EXECUTE FUNCTION trg_enforce_manifest_state_machine();

-- B. Automatic Immutable Audit Trail Logging Trigger
CREATE OR REPLACE FUNCTION trg_log_manifest_status_history()
RETURNS TRIGGER 
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor_id UUID;
    v_notes TEXT;
BEGIN
    IF OLD.status <> NEW.status THEN
        v_actor_id := auth.uid();
        IF v_actor_id IS NULL THEN
            IF NEW.status = 'RECEIVED' THEN
                v_actor_id := NEW.received_by;
            ELSIF NEW.status = 'IN_TRANSIT' THEN
                v_actor_id := NEW.dispatched_by;
            ELSIF NEW.status = 'CANCELLED' THEN
                v_actor_id := NEW.cancelled_by;
            ELSE
                v_actor_id := NEW.created_by;
            END IF;
        END IF;

        v_notes := CASE 
            WHEN NEW.status = 'READY_TO_DISPATCH' THEN 'Manifest dinyatakan siap diberangkatkan'
            WHEN NEW.status = 'IN_TRANSIT' THEN 'Manifest diberangkatkan menuju cabang tujuan'
            WHEN NEW.status = 'RECEIVED' THEN COALESCE(NEW.discrepancy_summary, 'Manifest diterima di cabang tujuan')
            WHEN NEW.status = 'CANCELLED' THEN COALESCE(NEW.notes, 'Manifest dibatalkan')
            ELSE NEW.notes
        END;

        INSERT INTO transit_manifest_history (
            manifest_id,
            organization_id,
            from_status,
            to_status,
            actor_id,
            notes,
            created_at
        ) VALUES (
            NEW.id,
            NEW.organization_id,
            OLD.status,
            NEW.status,
            COALESCE(v_actor_id, NEW.created_by),
            v_notes,
            NOW()
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_manifest_history_logger ON transit_manifests;
CREATE TRIGGER trg_manifest_history_logger
    AFTER UPDATE OF status ON transit_manifests
    FOR EACH ROW
    EXECUTE FUNCTION trg_log_manifest_status_history();

-- C. Concurrency Lock & Double-Dispatch Prevention Trigger
CREATE OR REPLACE FUNCTION trg_enforce_manifest_order_eligibility()
RETURNS TRIGGER 
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_manifest_status manifest_status_enum;
    v_manifest_org UUID;
    v_order_status order_status_enum;
    v_order_org UUID;
BEGIN
    -- 1. Acquire exclusive lock on target order to serialize concurrent manifest assignments
    PERFORM id FROM orders WHERE id = NEW.order_id FOR UPDATE;

    -- 2. Verify parent manifest status and tenant
    SELECT status, organization_id INTO v_manifest_status, v_manifest_org
    FROM transit_manifests WHERE id = NEW.manifest_id;

    IF v_manifest_status NOT IN ('DRAFT', 'READY_TO_DISPATCH') THEN
        RAISE EXCEPTION 'Cannot attach order to manifest % with status %.', NEW.manifest_id, v_manifest_status;
    END IF;

    -- 3. Verify order eligibility
    SELECT status, organization_id INTO v_order_status, v_order_org
    FROM orders WHERE id = NEW.order_id;

    IF v_order_org <> v_manifest_org THEN
        RAISE EXCEPTION 'Cross-tenant violation: Order org % does not match manifest org %.', v_order_org, v_manifest_org;
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

-- D. Decrement Expected Counter on Item Removal
CREATE OR REPLACE FUNCTION trg_sync_manifest_item_decrement()
RETURNS TRIGGER 
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE transit_manifests 
    SET total_expected_orders = GREATEST(0, total_expected_orders - 1),
        updated_at = NOW()
    WHERE id = OLD.manifest_id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_manifest_item_decrement ON transit_manifest_items;
CREATE TRIGGER trg_manifest_item_decrement
    AFTER DELETE ON transit_manifest_items
    FOR EACH ROW
    EXECUTE FUNCTION trg_sync_manifest_item_decrement();

-- E. Prevent Alteration of Core Keys on Existing Manifest Items
CREATE OR REPLACE FUNCTION trg_prevent_manifest_item_mutation()
RETURNS TRIGGER 
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.manifest_id <> NEW.manifest_id OR OLD.order_id <> NEW.order_id OR OLD.organization_id <> NEW.organization_id THEN
        RAISE EXCEPTION 'Cannot alter manifest_id, order_id, or organization_id on an existing manifest item.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_manifest_item_mutation_lock ON transit_manifest_items;
CREATE TRIGGER trg_manifest_item_mutation_lock
    BEFORE UPDATE ON transit_manifest_items
    FOR EACH ROW
    EXECUTE FUNCTION trg_prevent_manifest_item_mutation();

-- F. Protect Closed Shift from Receiving New Payments
CREATE OR REPLACE FUNCTION trg_prevent_payment_to_closed_shift()
RETURNS TRIGGER 
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_shift_status shift_status_enum;
BEGIN
    IF NEW.cashier_shift_id IS NOT NULL THEN
        SELECT status INTO v_shift_status 
        FROM cashier_shifts 
        WHERE id = NEW.cashier_shift_id;

        IF v_shift_status = 'CLOSED' THEN
            RAISE EXCEPTION 'Cannot record payment to a CLOSED cashier shift. Shift is audit-locked.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_closed_shift_check ON payments;
CREATE TRIGGER trg_payment_closed_shift_check
    BEFORE INSERT OR UPDATE ON payments
    FOR EACH ROW
    EXECUTE FUNCTION trg_prevent_payment_to_closed_shift();

-- G. Driver Tenant and Role Validation Trigger
CREATE OR REPLACE FUNCTION trg_validate_manifest_driver()
RETURNS TRIGGER 
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_driver_role user_role_enum;
    v_driver_org UUID;
BEGIN
    IF NEW.driver_user_id IS NOT NULL THEN
        SELECT role, organization_id INTO v_driver_role, v_driver_org
        FROM users 
        WHERE id = NEW.driver_user_id;

        IF v_driver_org <> NEW.organization_id THEN
            RAISE EXCEPTION 'Cross-tenant violation: Driver % belongs to org %, but manifest is for org %.', 
                NEW.driver_user_id, v_driver_org, NEW.organization_id;
        END IF;

        IF v_driver_role NOT IN ('DRIVER', 'OPERATOR', 'BRANCH_MANAGER', 'ADMIN', 'OWNER') THEN
            RAISE EXCEPTION 'User % does not have an eligible role to be assigned as manifest driver.', NEW.driver_user_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_manifest_driver_check ON transit_manifests;
CREATE TRIGGER trg_manifest_driver_check
    BEFORE INSERT OR UPDATE ON transit_manifests
    FOR EACH ROW
    EXECUTE FUNCTION trg_validate_manifest_driver();

-- ----------------------------------------------------------------------------
-- 9. TRANSACTIONAL RPC FUNCTIONS (SECURITY DEFINER WITH STRICT SEARCH_PATH)
-- ----------------------------------------------------------------------------

-- A. Atomic Creation of Manifest with Initial Orders
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
        -- to completely eliminate circular-wait deadlocks between concurrent batch transactions
        PERFORM id 
        FROM orders 
        WHERE id = ANY(p_order_ids) 
        ORDER BY id 
        FOR UPDATE;

        -- Verify that all requested orders exist and belong to the organization
        IF (SELECT count(DISTINCT unnest(p_order_ids))) <> (
            SELECT count(*) FROM orders WHERE id = ANY(p_order_ids) AND organization_id = v_org_id
        ) THEN
            RAISE EXCEPTION 'One or more order IDs do not exist or belong to a different organization.';
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

-- B. Atomic State Transition
CREATE OR REPLACE FUNCTION transition_manifest_status(
    p_manifest_id UUID,
    p_target_status manifest_status_enum,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_manifest transit_manifests%ROWTYPE;
BEGIN
    SELECT * INTO v_manifest FROM transit_manifests WHERE id = p_manifest_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Manifest % not found.', p_manifest_id;
    END IF;

    -- Verify access
    IF NOT (
        user_has_branch_access(v_manifest.source_branch_id) OR 
        user_has_branch_access(v_manifest.destination_branch_id) OR
        v_manifest.driver_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Access denied for manifest %.', p_manifest_id;
    END IF;

    -- Update based on target status
    IF p_target_status = 'READY_TO_DISPATCH' THEN
        IF v_manifest.total_expected_orders = 0 THEN
            RAISE EXCEPTION 'Cannot mark manifest READY_TO_DISPATCH without any attached orders.';
        END IF;
        UPDATE transit_manifests
        SET status = 'READY_TO_DISPATCH',
            notes = COALESCE(p_notes, notes),
            updated_at = NOW()
        WHERE id = p_manifest_id;

    ELSIF p_target_status = 'IN_TRANSIT' THEN
        UPDATE transit_manifests
        SET status = 'IN_TRANSIT',
            dispatched_by = auth.uid(),
            dispatched_at = NOW(),
            notes = COALESCE(p_notes, notes),
            updated_at = NOW()
        WHERE id = p_manifest_id;

    ELSIF p_target_status = 'CANCELLED' THEN
        UPDATE transit_manifests
        SET status = 'CANCELLED',
            cancelled_by = auth.uid(),
            cancelled_at = NOW(),
            notes = COALESCE(p_notes, notes),
            updated_at = NOW()
        WHERE id = p_manifest_id;

    ELSIF p_target_status = 'DRAFT' THEN
        UPDATE transit_manifests
        SET status = 'DRAFT',
            notes = COALESCE(p_notes, notes),
            updated_at = NOW()
        WHERE id = p_manifest_id;

    ELSE
        RAISE EXCEPTION 'Use receive_manifest_with_discrepancy for RECEIVED transition.';
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'manifest_id', p_manifest_id,
        'new_status', p_target_status
    );
END;
$$;

-- C. Atomic Manifest Receiving with Item-Level Discrepancy Tracking
CREATE OR REPLACE FUNCTION receive_manifest_with_discrepancy(
    p_manifest_id UUID,
    p_items_review JSONB,
    p_summary_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_manifest transit_manifests%ROWTYPE;
    v_item RECORD;
    v_order_id UUID;
    v_item_status manifest_item_status_enum;
    v_item_note TEXT;
    v_received_count INT := 0;
    v_discrepancy_count INT := 0;
    v_has_discrepancy BOOLEAN := FALSE;
    v_summary_msg TEXT;
BEGIN
    SELECT * INTO v_manifest FROM transit_manifests WHERE id = p_manifest_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Manifest % not found.', p_manifest_id;
    END IF;

    IF v_manifest.status <> 'IN_TRANSIT' THEN
        RAISE EXCEPTION 'Cannot receive manifest % with status %. Manifest must be IN_TRANSIT.', 
            p_manifest_id, v_manifest.status;
    END IF;

    -- Validate destination branch authorization
    IF NOT user_has_branch_access(v_manifest.destination_branch_id) THEN
        RAISE EXCEPTION 'Access denied: caller does not have access to destination branch %.', 
            v_manifest.destination_branch_id;
    END IF;

    -- Process each item review from JSONB array
    FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items_review) AS x(
        order_id UUID,
        status TEXT,
        notes TEXT
    ) LOOP
        v_order_id := v_item.order_id;
        v_item_status := v_item.status::manifest_item_status_enum;
        v_item_note := v_item.notes;

        -- Update item status and notes
        UPDATE transit_manifest_items
        SET received_status = v_item_status,
            discrepancy_notes = v_item_note,
            received_at = NOW(),
            inspected_by = auth.uid()
        WHERE manifest_id = p_manifest_id AND order_id = v_order_id;

        IF v_item_status = 'RECEIVED_OK' THEN
            v_received_count := v_received_count + 1;
        ELSE
            v_discrepancy_count := v_discrepancy_count + 1;
            v_has_discrepancy := TRUE;
        END IF;
    END LOOP;

    -- Check if any expected items were omitted from review
    UPDATE transit_manifest_items
    SET received_status = 'MISSING',
        discrepancy_notes = 'Tidak ditemukan dalam inspeksi kedatangan',
        received_at = NOW(),
        inspected_by = auth.uid()
    WHERE manifest_id = p_manifest_id AND received_status = 'EXPECTED';

    GET DIAGNOSTICS v_discrepancy_count = ROW_COUNT;
    IF v_discrepancy_count > 0 THEN
        v_has_discrepancy := TRUE;
    END IF;

    -- Compile summary message
    IF v_has_discrepancy THEN
        v_summary_msg := COALESCE(p_summary_notes, 'Diterima dengan selisih/discrepancy item');
    ELSE
        v_summary_msg := COALESCE(p_summary_notes, 'Diterima lengkap & sesuai');
    END IF;

    -- Update manifest record to RECEIVED (terminal state)
    UPDATE transit_manifests
    SET status = 'RECEIVED',
        received_by = auth.uid(),
        received_at = NOW(),
        total_received_orders = v_received_count,
        has_discrepancy = v_has_discrepancy,
        discrepancy_summary = v_summary_msg,
        updated_at = NOW()
    WHERE id = p_manifest_id;

    RETURN jsonb_build_object(
        'success', true,
        'manifest_id', p_manifest_id,
        'received_orders', v_received_count,
        'has_discrepancy', v_has_discrepancy,
        'discrepancy_summary', v_summary_msg
    );
END;
$$;

-- D. Atomic Cashier Shift Reconciliation & Close
CREATE OR REPLACE FUNCTION close_cashier_shift_reconciled(
    p_shift_id UUID,
    p_actual_cash NUMERIC(12, 2),
    p_variance_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_shift cashier_shifts%ROWTYPE;
    v_cash_sales NUMERIC(12, 2) := 0.0;
    v_qris_sales NUMERIC(12, 2) := 0.0;
    v_transfer_sales NUMERIC(12, 2) := 0.0;
    v_tx_count INT := 0;
    v_expected_cash NUMERIC(12, 2) := 0.0;
    v_difference NUMERIC(12, 2) := 0.0;
BEGIN
    SELECT * INTO v_shift FROM cashier_shifts WHERE id = p_shift_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cashier shift % not found.', p_shift_id;
    END IF;

    IF v_shift.status = 'CLOSED' THEN
        RAISE EXCEPTION 'Cannot modify or re-close a CLOSED shift. Shift is audit-locked.';
    END IF;

    -- Authorize caller
    IF NOT user_has_branch_access(v_shift.branch_id) THEN
        RAISE EXCEPTION 'Access denied for branch %.', v_shift.branch_id;
    END IF;

    -- Aggregate payment transactions tied to this shift
    SELECT 
        COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN payment_method = 'QRIS_MANUAL' THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN payment_method = 'BANK_TRANSFER' THEN amount ELSE 0 END), 0),
        COUNT(*)
    INTO 
        v_cash_sales, 
        v_qris_sales, 
        v_transfer_sales, 
        v_tx_count
    FROM payments
    WHERE cashier_shift_id = p_shift_id AND status = 'SUCCESS';

    -- Physical cash formula:
    -- Expected Cash = Opening Cash + Cash Sales + Cash In - Cash Out - Refund Amount
    v_expected_cash := v_shift.opening_cash + v_cash_sales + v_shift.cash_in - v_shift.cash_out - v_shift.refund_amount;
    v_difference := p_actual_cash - v_expected_cash;

    -- Enforce variance note if variance <> 0
    IF v_difference <> 0 THEN
        IF p_variance_note IS NULL OR length(trim(p_variance_note)) < 5 THEN
            RAISE EXCEPTION 'Selisih kas terdeteksi (%). Wajib mencantumkan variance_note minimal 5 karakter.', v_difference;
        END IF;
    END IF;

    -- Update and lock the shift
    UPDATE cashier_shifts
    SET actual_cash = p_actual_cash,
        expected_cash = v_expected_cash,
        difference = v_difference,
        cash_sales = v_cash_sales,
        qris_sales = v_qris_sales,
        transfer_sales = v_transfer_sales,
        transaction_count = v_tx_count,
        variance_note = p_variance_note,
        status = 'CLOSED',
        closed_at = NOW(),
        closed_by = auth.uid()
    WHERE id = p_shift_id;

    RETURN jsonb_build_object(
        'success', true,
        'shift_id', p_shift_id,
        'opening_cash', v_shift.opening_cash,
        'cash_sales', v_cash_sales,
        'qris_sales', v_qris_sales,
        'transfer_sales', v_transfer_sales,
        'expected_cash', v_expected_cash,
        'actual_cash', p_actual_cash,
        'difference', v_difference,
        'status', 'CLOSED'
    );
END;
$$;

-- Revoke default public execution and grant to authenticated role
REVOKE EXECUTE ON FUNCTION create_manifest_with_orders(VARCHAR, UUID, UUID, UUID, VARCHAR, TEXT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_manifest_with_orders(VARCHAR, UUID, UUID, UUID, VARCHAR, TEXT, UUID[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION transition_manifest_status(UUID, manifest_status_enum, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION transition_manifest_status(UUID, manifest_status_enum, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION receive_manifest_with_discrepancy(UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION receive_manifest_with_discrepancy(UUID, JSONB, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION close_cashier_shift_reconciled(UUID, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_cashier_shift_reconciled(UUID, NUMERIC, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 10. ROW LEVEL SECURITY (RLS) POLICIES
-- ----------------------------------------------------------------------------
ALTER TABLE transit_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE transit_manifest_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE transit_manifest_history ENABLE ROW LEVEL SECURITY;

-- A. Policies for transit_manifests
CREATE POLICY transit_manifests_select ON transit_manifests
    FOR SELECT USING (
        organization_id = auth_org_id() AND (
            user_has_branch_access(source_branch_id) OR
            user_has_branch_access(destination_branch_id) OR
            driver_user_id = auth.uid()
        )
    );

CREATE POLICY transit_manifests_insert ON transit_manifests
    FOR INSERT WITH CHECK (
        organization_id = auth_org_id() AND
        user_has_branch_access(source_branch_id) AND
        created_by = auth.uid()
    );

CREATE POLICY transit_manifests_update ON transit_manifests
    FOR UPDATE USING (
        organization_id = auth_org_id() AND (
            user_has_branch_access(source_branch_id) OR
            user_has_branch_access(destination_branch_id) OR
            driver_user_id = auth.uid()
        )
    ) WITH CHECK (
        organization_id = auth_org_id() AND (
            user_has_branch_access(source_branch_id) OR
            user_has_branch_access(destination_branch_id) OR
            driver_user_id = auth.uid()
        )
    );

-- B. Policies for transit_manifest_items
CREATE POLICY transit_manifest_items_select ON transit_manifest_items
    FOR SELECT USING (
        organization_id = auth_org_id() AND
        EXISTS (
            SELECT 1 FROM transit_manifests tm
            WHERE tm.id = transit_manifest_items.manifest_id
            AND (
                user_has_branch_access(tm.source_branch_id) OR
                user_has_branch_access(tm.destination_branch_id) OR
                tm.driver_user_id = auth.uid()
            )
        )
    );

CREATE POLICY transit_manifest_items_insert ON transit_manifest_items
    FOR INSERT WITH CHECK (
        organization_id = auth_org_id() AND
        EXISTS (
            SELECT 1 FROM transit_manifests tm
            WHERE tm.id = transit_manifest_items.manifest_id
            AND user_has_branch_access(tm.source_branch_id)
            AND tm.status = 'DRAFT'
        )
    );

CREATE POLICY transit_manifest_items_update ON transit_manifest_items
    FOR UPDATE USING (
        organization_id = auth_org_id() AND
        EXISTS (
            SELECT 1 FROM transit_manifests tm
            WHERE tm.id = transit_manifest_items.manifest_id
            AND (
                user_has_branch_access(tm.source_branch_id) OR
                user_has_branch_access(tm.destination_branch_id)
            )
        )
    ) WITH CHECK (
        organization_id = auth_org_id() AND
        EXISTS (
            SELECT 1 FROM transit_manifests tm
            WHERE tm.id = transit_manifest_items.manifest_id
            AND (
                user_has_branch_access(tm.source_branch_id) OR
                user_has_branch_access(tm.destination_branch_id)
            )
        )
    );

CREATE POLICY transit_manifest_items_delete ON transit_manifest_items
    FOR DELETE USING (
        organization_id = auth_org_id() AND
        EXISTS (
            SELECT 1 FROM transit_manifests tm
            WHERE tm.id = transit_manifest_items.manifest_id
            AND user_has_branch_access(tm.source_branch_id)
            AND tm.status = 'DRAFT'
        )
    );

-- C. Policies for transit_manifest_history (Immutable Audit Trail)
CREATE POLICY transit_manifest_history_select ON transit_manifest_history
    FOR SELECT USING (
        organization_id = auth_org_id() AND
        EXISTS (
            SELECT 1 FROM transit_manifests tm
            WHERE tm.id = transit_manifest_history.manifest_id
            AND (
                user_has_branch_access(tm.source_branch_id) OR
                user_has_branch_access(tm.destination_branch_id) OR
                tm.driver_user_id = auth.uid()
            )
        )
    );

CREATE POLICY transit_manifest_history_insert ON transit_manifest_history
    FOR INSERT WITH CHECK (
        organization_id = auth_org_id() AND
        actor_id = auth.uid()
    );

-- NO UPDATE or DELETE policies for transit_manifest_history:
-- History is strictly immutable for forensics and JCI audit trail compliance.
