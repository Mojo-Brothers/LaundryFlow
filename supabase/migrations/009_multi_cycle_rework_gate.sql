-- ============================================================================
-- 009_multi_cycle_rework_gate.sql
-- LAUNDRYFLOW SAAS — MULTI-CYCLE TRANSIT & REWORK GATE ENFORCEMENT
--
-- Preserves:
-- 1. Model C: orders.branch_id = permanent commercial origin (IMMUTABLE)
-- 2. orders.production_branch_id = designated fulfillment workshop
-- 3. orders.status = production stage (unchanged by transit)
-- 4. No custody shadow columns, no cycle_number on orders
-- 5. Rework Gate: 1 APPROVED authorization per order -> 1 Outbound cycle (CONSUMED)
-- 6. Discrepancy handling: DAMAGED return allowed, MISSING & WRONG_BRANCH blocked
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CREATE TABLE order_rework_requests
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_rework_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    requested_by UUID NOT NULL REFERENCES users(id),
    reason VARCHAR(40) NOT NULL CHECK (
        reason IN (
            'CUSTOMER_COMPLAINT',
            'STAIN_REMAINS',
            'ODOR_REMAINS',
            'WRONG_TREATMENT',
            'OUTLET_QC_REJECT',
            'OTHER'
        )
    ),
    notes TEXT NULL,
    status VARCHAR(20) NOT NULL CHECK (
        status IN (
            'APPROVED',
            'CONSUMED',
            'CANCELLED'
        )
    ),
    consumed_manifest_id UUID NULL REFERENCES transit_manifests(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consumed_at TIMESTAMPTZ NULL,
    cancelled_at TIMESTAMPTZ NULL,
    cancelled_by UUID NULL REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_order_rework_order_id ON order_rework_requests(order_id);
CREATE INDEX IF NOT EXISTS idx_order_rework_org_id ON order_rework_requests(organization_id);

-- Critical Invariant: Maksimal 1 request berstatus APPROVED per order
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_rework_one_active
ON order_rework_requests(order_id)
WHERE status = 'APPROVED';

-- ----------------------------------------------------------------------------
-- 2. ROW LEVEL SECURITY (RLS) FOR order_rework_requests
-- ----------------------------------------------------------------------------
ALTER TABLE order_rework_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_rework_select_policy ON order_rework_requests;
CREATE POLICY order_rework_select_policy ON order_rework_requests
    FOR SELECT USING (
        organization_id = auth_org_id() AND
        EXISTS (
            SELECT 1 FROM orders o
            WHERE o.id = order_rework_requests.order_id
              AND (user_has_branch_access(o.branch_id) OR user_has_branch_access(o.production_branch_id))
        )
    );

DROP POLICY IF EXISTS order_rework_insert_policy ON order_rework_requests;
CREATE POLICY order_rework_insert_policy ON order_rework_requests
    FOR INSERT WITH CHECK (
        organization_id = auth_org_id() AND
        requested_by = auth.uid()
    );

DROP POLICY IF EXISTS order_rework_update_policy ON order_rework_requests;
CREATE POLICY order_rework_update_policy ON order_rework_requests
    FOR UPDATE USING (
        organization_id = auth_org_id()
    ) WITH CHECK (
        organization_id = auth_org_id()
    );

-- Enforce terminal immutability for CONSUMED / CANCELLED rework requests
CREATE OR REPLACE FUNCTION trg_order_rework_status_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status IN ('CONSUMED', 'CANCELLED') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'Illegal status transition: rework request in status % cannot be transitioned to %.', OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_order_rework_status_immutability ON order_rework_requests;
CREATE TRIGGER enforce_order_rework_status_immutability
    BEFORE UPDATE OF status ON order_rework_requests
    FOR EACH ROW
    EXECUTE FUNCTION trg_order_rework_status_immutability();

-- ----------------------------------------------------------------------------
-- 3. SECURE RPC: create_order_rework_request()
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_order_rework_request(
    p_order_id UUID,
    p_reason VARCHAR(40),
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_org_id UUID;
    v_user_role user_role_enum;
    v_order_org UUID;
    v_order_branch UUID;
    v_order_prod_branch UUID;
    v_order_status order_status_enum;
    v_latest_outbound TIMESTAMPTZ;
    v_latest_return TIMESTAMPTZ;
    v_rework_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: User authentication required.';
    END IF;

    v_org_id := auth_org_id();
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Organization context required.';
    END IF;

    -- Validate user role
    SELECT role INTO v_user_role FROM users WHERE id = v_user_id;
    IF v_user_role NOT IN ('OWNER', 'ADMIN', 'MANAGER', 'BRANCH_MANAGER', 'CASHIER') THEN
        RAISE EXCEPTION 'Access denied: Role % is not authorized to create rework requests.', v_user_role;
    END IF;

    -- Fetch order
    SELECT organization_id, branch_id, production_branch_id, status
    INTO v_order_org, v_order_branch, v_order_prod_branch, v_order_status
    FROM orders WHERE id = p_order_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Order % tidak ditemukan.', p_order_id;
    END IF;

    IF v_order_org <> v_org_id THEN
        RAISE EXCEPTION 'Cross-tenant violation: Order belongs to another organization.';
    END IF;

    -- Validate user branch access to origin outlet
    IF NOT user_has_branch_access(v_order_branch) THEN
        RAISE EXCEPTION 'Access denied: User does not have access to origin outlet branch %.', v_order_branch;
    END IF;

    -- Validate order lifecycle (not terminal)
    IF v_order_status IN ('CANCELLED', 'COMPLETED') THEN
        RAISE EXCEPTION 'Order % dengan status % tidak dapat diajukan rework.', p_order_id, v_order_status;
    END IF;

    -- Validate reason code
    IF p_reason NOT IN ('CUSTOMER_COMPLAINT', 'STAIN_REMAINS', 'ODOR_REMAINS', 'WRONG_TREATMENT', 'OUTLET_QC_REJECT', 'OTHER') THEN
        RAISE EXCEPTION 'Invalid rework reason code: %.', p_reason;
    END IF;

    -- Check physical custody: order must be physically at origin outlet!
    SELECT MAX(tm.received_at)
    INTO v_latest_outbound
    FROM transit_manifest_items tmi
    JOIN transit_manifests tm ON tm.id = tmi.manifest_id
    WHERE tmi.order_id = p_order_id
      AND tm.source_branch_id = v_order_branch
      AND tm.destination_branch_id = v_order_prod_branch
      AND tm.status = 'RECEIVED'
      AND tmi.received_status IN ('RECEIVED_OK', 'DAMAGED');

    IF v_latest_outbound IS NOT NULL THEN
        -- If order has been dispatched outbound, it MUST have completed a return that was received at origin!
        SELECT MAX(tm.received_at)
        INTO v_latest_return
        FROM transit_manifest_items tmi
        JOIN transit_manifests tm ON tm.id = tmi.manifest_id
        WHERE tmi.order_id = p_order_id
          AND tm.source_branch_id = v_order_prod_branch
          AND tm.destination_branch_id = v_order_branch
          AND tm.status = 'RECEIVED'
          AND tmi.received_status IN ('RECEIVED_OK', 'DAMAGED');

        IF v_latest_return IS NULL OR v_latest_return < v_latest_outbound THEN
            RAISE EXCEPTION 'Physical custody violation: Order % is not physically at origin outlet (awaiting return receipt).', p_order_id;
        END IF;
    END IF;

    -- Check if active manifest exists
    IF EXISTS (
        SELECT 1
        FROM transit_manifest_items tmi
        JOIN transit_manifests tm ON tm.id = tmi.manifest_id
        WHERE tmi.order_id = p_order_id
          AND tm.status IN ('DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT')
    ) THEN
        RAISE EXCEPTION 'Order % sedang berada dalam manifest aktif dan tidak dapat diajukan rework.', p_order_id;
    END IF;

    -- Check existing active APPROVED rework request
    IF EXISTS (
        SELECT 1 FROM order_rework_requests
        WHERE order_id = p_order_id AND status = 'APPROVED'
    ) THEN
        RAISE EXCEPTION 'Order % already has an active approved rework request.', p_order_id;
    END IF;

    -- Insert request
    INSERT INTO order_rework_requests (
        organization_id,
        order_id,
        requested_by,
        reason,
        notes,
        status,
        created_at
    ) VALUES (
        v_org_id,
        p_order_id,
        v_user_id,
        p_reason,
        p_notes,
        'APPROVED',
        NOW()
    ) RETURNING id INTO v_rework_id;

    RETURN jsonb_build_object(
        'success', true,
        'rework_request_id', v_rework_id,
        'order_id', p_order_id,
        'status', 'APPROVED'
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION create_order_rework_request(UUID, VARCHAR, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_order_rework_request(UUID, VARCHAR, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. SECURE RPC: cancel_order_rework_request()
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cancel_order_rework_request(
    p_request_id UUID,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_org_id UUID;
    v_req_status VARCHAR(20);
    v_req_org UUID;
    v_order_id UUID;
    v_order_branch UUID;
BEGIN
    v_user_id := auth.uid();
    v_org_id := auth_org_id();

    SELECT r.status, r.organization_id, r.order_id, o.branch_id
    INTO v_req_status, v_req_org, v_order_id, v_order_branch
    FROM order_rework_requests r
    JOIN orders o ON o.id = r.order_id
    WHERE r.id = p_request_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rework request % tidak ditemukan.', p_request_id;
    END IF;

    IF v_req_org <> v_org_id THEN
        RAISE EXCEPTION 'Cross-tenant violation: Rework request belongs to another organization.';
    END IF;

    IF NOT user_has_branch_access(v_order_branch) THEN
        RAISE EXCEPTION 'Access denied: User does not have access to origin outlet.';
    END IF;

    IF v_req_status <> 'APPROVED' THEN
        RAISE EXCEPTION 'Illegal state: Only APPROVED rework requests can be cancelled (current: %).', v_req_status;
    END IF;

    UPDATE order_rework_requests
    SET status = 'CANCELLED',
        cancelled_at = NOW(),
        cancelled_by = v_user_id,
        notes = COALESCE(notes, '') || CASE WHEN p_notes IS NOT NULL THEN ' | Batal: ' || p_notes ELSE '' END
    WHERE id = p_request_id;

    RETURN jsonb_build_object('success', true, 'rework_request_id', p_request_id, 'status', 'CANCELLED');
END;
$$;

REVOKE EXECUTE ON FUNCTION cancel_order_rework_request(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cancel_order_rework_request(UUID, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. REVISE trg_enforce_manifest_order_eligibility() TRIGGER FUNCTION
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
    v_latest_return_received TIMESTAMPTZ;
BEGIN
    -- 1. Acquire exclusive lock on target order to serialize concurrent manifest assignments
    PERFORM id FROM orders WHERE id = NEW.order_id FOR UPDATE;

    -- 2. Verify parent manifest status, tenant context, source branch, and destination branch with row lock (FOR SHARE)
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

    -- 5. DIRECTED ROUTE DETERMINATION & VALIDATION (Model C Contract + Multi-Cycle)
    
    -- Case A: OUTBOUND ROUTE (Origin Outlet -> Production Workshop)
    IF v_manifest_src = v_order_branch THEN
        IF v_manifest_dest <> v_order_prod_branch THEN
            RAISE EXCEPTION 'Outbound route violation: Order % with production branch % cannot be dispatched to destination branch %.',
                NEW.order_id, v_order_prod_branch, v_manifest_dest;
        END IF;

        -- Find latest completed Outbound receipt
        SELECT MAX(tm_out.received_at)
        INTO v_latest_outbound_received
        FROM transit_manifest_items tmi_out
        JOIN transit_manifests tm_out ON tm_out.id = tmi_out.manifest_id
        WHERE tmi_out.order_id = NEW.order_id
          AND tm_out.source_branch_id = v_order_branch
          AND tm_out.destination_branch_id = v_order_prod_branch
          AND tm_out.status = 'RECEIVED'
          AND tmi_out.received_status IN ('RECEIVED_OK', 'DAMAGED');

        IF v_latest_outbound_received IS NOT NULL THEN
            -- Find latest completed Return receipt
            SELECT MAX(tm_ret.received_at)
            INTO v_latest_return_received
            FROM transit_manifest_items tmi_ret
            JOIN transit_manifests tm_ret ON tm_ret.id = tmi_ret.manifest_id
            WHERE tmi_ret.order_id = NEW.order_id
              AND tm_ret.source_branch_id = v_order_prod_branch
              AND tm_ret.destination_branch_id = v_order_branch
              AND tm_ret.status = 'RECEIVED'
              AND tmi_ret.received_status IN ('RECEIVED_OK', 'DAMAGED');

            IF v_latest_return_received IS NULL OR v_latest_return_received < v_latest_outbound_received THEN
                RAISE EXCEPTION 'Outbound route violation: Order % has already been received at production branch % and has not been returned.',
                    NEW.order_id, v_order_prod_branch;
            END IF;

            -- Order has returned to origin (Cycle 1 complete). For Cycle 2+, require an APPROVED rework authorization (or already CONSUMED by this manifest)!
            IF NOT EXISTS (
                SELECT 1 FROM order_rework_requests
                WHERE order_id = NEW.order_id 
                  AND (status = 'APPROVED' OR (status = 'CONSUMED' AND consumed_manifest_id = NEW.manifest_id))
            ) THEN
                RAISE EXCEPTION 'Outbound route violation: Order % requires an active approved rework request for additional outbound transit.',
                    NEW.order_id;
            END IF;

            -- If item was inserted directly (outside create_manifest_with_orders), consume the APPROVED token now
            UPDATE order_rework_requests
            SET status = 'CONSUMED',
                consumed_manifest_id = NEW.manifest_id,
                consumed_at = NOW()
            WHERE order_id = NEW.order_id AND status = 'APPROVED';
        END IF;

    -- Case B: RETURN ROUTE (Production Workshop -> Origin Outlet)
    ELSIF v_manifest_src = v_order_prod_branch THEN
        IF v_manifest_dest <> v_order_branch THEN
            RAISE EXCEPTION 'Return route violation: Order % originating from branch % cannot be returned to destination branch %.',
                NEW.order_id, v_order_branch, v_manifest_dest;
        END IF;

        -- Return requires a prior Outbound manifest that was RECEIVED with RECEIVED_OK or DAMAGED
        SELECT MAX(tm_prev.received_at)
        INTO v_latest_outbound_received
        FROM transit_manifest_items tmi_prev
        JOIN transit_manifests tm_prev ON tm_prev.id = tmi_prev.manifest_id
        WHERE tmi_prev.order_id = NEW.order_id
          AND tm_prev.source_branch_id = v_order_branch
          AND tm_prev.destination_branch_id = v_order_prod_branch
          AND tm_prev.status = 'RECEIVED'
          AND tmi_prev.received_status IN ('RECEIVED_OK', 'DAMAGED');

        IF v_latest_outbound_received IS NULL THEN
            RAISE EXCEPTION 'Return route violation: Order % cannot be returned from % to % because no prior RECEIVED outbound transit exists.',
                NEW.order_id, v_manifest_src, v_manifest_dest;
        END IF;

        -- Forbid return if latest outbound transit was marked as MISSING or WRONG_BRANCH
        IF EXISTS (
            SELECT 1
            FROM transit_manifest_items tmi_bad
            JOIN transit_manifests tm_bad ON tm_bad.id = tmi_bad.manifest_id
            WHERE tmi_bad.order_id = NEW.order_id
              AND tm_bad.source_branch_id = v_order_branch
              AND tm_bad.destination_branch_id = v_order_prod_branch
              AND tm_bad.status = 'RECEIVED'
              AND tmi_bad.received_status IN ('MISSING', 'WRONG_BRANCH')
              AND tm_bad.received_at > v_latest_outbound_received
        ) THEN
            RAISE EXCEPTION 'Return route violation: Order % cannot be returned because latest outbound transit was marked as MISSING or WRONG_BRANCH.',
                NEW.order_id;
        END IF;

        -- Forbid duplicate return if already returned after that latest outbound receipt
        IF EXISTS (
            SELECT 1
            FROM transit_manifest_items tmi_ret
            JOIN transit_manifests tm_ret ON tm_ret.id = tmi_ret.manifest_id
            WHERE tmi_ret.order_id = NEW.order_id
              AND tm_ret.source_branch_id = v_order_prod_branch
              AND tm_ret.destination_branch_id = v_order_branch
              AND tm_ret.status = 'RECEIVED'
              AND tmi_ret.received_status IN ('RECEIVED_OK', 'DAMAGED')
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
-- 6. REVISE create_manifest_with_orders() RPC (WITH ATOMIC REWORK CONSUMPTION)
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
    v_latest_return_received TIMESTAMPTZ;
    v_rework_req_id UUID;
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

                -- Check latest outbound receipt
                SELECT MAX(tm_out.received_at)
                INTO v_latest_outbound_received
                FROM transit_manifest_items tmi_out
                JOIN transit_manifests tm_out ON tm_out.id = tmi_out.manifest_id
                WHERE tmi_out.order_id = v_order_id
                  AND tm_out.source_branch_id = v_ord_branch
                  AND tm_out.destination_branch_id = v_ord_prod_branch
                  AND tm_out.status = 'RECEIVED'
                  AND tmi_out.received_status IN ('RECEIVED_OK', 'DAMAGED');

                IF v_latest_outbound_received IS NOT NULL THEN
                    -- Check latest return receipt
                    SELECT MAX(tm_ret.received_at)
                    INTO v_latest_return_received
                    FROM transit_manifest_items tmi_ret
                    JOIN transit_manifests tm_ret ON tm_ret.id = tmi_ret.manifest_id
                    WHERE tmi_ret.order_id = v_order_id
                      AND tm_ret.source_branch_id = v_ord_prod_branch
                      AND tm_ret.destination_branch_id = v_ord_branch
                      AND tm_ret.status = 'RECEIVED'
                      AND tmi_ret.received_status IN ('RECEIVED_OK', 'DAMAGED');

                    IF v_latest_return_received IS NULL OR v_latest_return_received < v_latest_outbound_received THEN
                        RAISE EXCEPTION 'Outbound route violation: Order % has already been received at production branch % and has not been returned.',
                            v_order_id, v_ord_prod_branch;
                    END IF;

                    -- Order has completed prior cycle. Lock and consume active APPROVED rework request!
                    SELECT id INTO v_rework_req_id
                    FROM order_rework_requests
                    WHERE order_id = v_order_id AND status = 'APPROVED'
                    FOR UPDATE;

                    IF v_rework_req_id IS NULL THEN
                        RAISE EXCEPTION 'Outbound route violation: Order % requires an active approved rework request for additional outbound transit.',
                            v_order_id;
                    END IF;

                    UPDATE order_rework_requests
                    SET status = 'CONSUMED',
                        consumed_manifest_id = v_manifest_id,
                        consumed_at = NOW()
                    WHERE id = v_rework_req_id;
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
                  AND tmi_prev.received_status IN ('RECEIVED_OK', 'DAMAGED');

                IF v_latest_outbound_received IS NULL THEN
                    RAISE EXCEPTION 'Return route violation: Order % cannot be returned from % to % because no prior RECEIVED outbound transit exists.',
                        v_order_id, p_source_branch_id, p_destination_branch_id;
                END IF;

                -- Forbid return if latest outbound transit was marked as MISSING or WRONG_BRANCH
                IF EXISTS (
                    SELECT 1
                    FROM transit_manifest_items tmi_bad
                    JOIN transit_manifests tm_bad ON tm_bad.id = tmi_bad.manifest_id
                    WHERE tmi_bad.order_id = v_order_id
                      AND tm_bad.source_branch_id = v_ord_branch
                      AND tm_bad.destination_branch_id = v_ord_prod_branch
                      AND tm_bad.status = 'RECEIVED'
                      AND tmi_bad.received_status IN ('MISSING', 'WRONG_BRANCH')
                      AND tm_bad.received_at > v_latest_outbound_received
                ) THEN
                    RAISE EXCEPTION 'Return route violation: Order % cannot be returned because latest outbound transit was marked as MISSING or WRONG_BRANCH.',
                        v_order_id;
                END IF;

                IF EXISTS (
                    SELECT 1
                    FROM transit_manifest_items tmi_ret
                    JOIN transit_manifests tm_ret ON tm_ret.id = tmi_ret.manifest_id
                    WHERE tmi_ret.order_id = v_order_id
                      AND tm_ret.source_branch_id = v_ord_prod_branch
                      AND tm_ret.destination_branch_id = v_ord_branch
                      AND tm_ret.status = 'RECEIVED'
                      AND tmi_ret.received_status IN ('RECEIVED_OK', 'DAMAGED')
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
