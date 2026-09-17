-- ============================================================================
-- 002_rls_and_security.sql
-- LaundryFlow SaaS: Row Level Security, Tenant Isolation & Immutability Enforcement
-- (Phase 1.5 Hardened: Zero Global Read Leak, Isolated Tracking RPC, & Shift Lock)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. SECURITY DEFINER HELPER FUNCTIONS
-- ----------------------------------------------------------------------------

-- Extract organization_id from user's app_metadata in JWT or fallback to users table
CREATE OR REPLACE FUNCTION auth_org_id()
RETURNS UUID AS $$
DECLARE
    v_org_id UUID;
BEGIN
    v_org_id := (auth.jwt() -> 'app_metadata' ->> 'organization_id')::uuid;
    IF v_org_id IS NULL THEN
        SELECT organization_id INTO v_org_id FROM public.users WHERE id = auth.uid();
    END IF;
    RETURN v_org_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Check if current authenticated user has branch access or is Organization Owner/Admin
CREATE OR REPLACE FUNCTION user_has_branch_access(p_branch_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_role user_role_enum;
    v_has_access BOOLEAN;
BEGIN
    SELECT role INTO v_role FROM public.users WHERE id = auth.uid();
    
    IF v_role IN ('OWNER', 'ADMIN') THEN
        RETURN TRUE;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.user_branch_access uba
        WHERE uba.user_id = auth.uid() AND uba.branch_id = p_branch_id
    ) INTO v_has_access;

    RETURN COALESCE(v_has_access, FALSE);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ----------------------------------------------------------------------------
-- 2. ENABLE ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_branch_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashier_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 3. RLS POLICIES FOR ORGANIZATIONS
-- ----------------------------------------------------------------------------
CREATE POLICY organizations_select_policy ON organizations
    FOR SELECT USING (id = auth_org_id());

-- ----------------------------------------------------------------------------
-- 4. RLS POLICIES FOR BRANCHES
-- ----------------------------------------------------------------------------
CREATE POLICY branches_select_policy ON branches
    FOR SELECT USING (organization_id = auth_org_id());

CREATE POLICY branches_all_admin ON branches
    FOR ALL USING (
        organization_id = auth_org_id() AND 
        EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('OWNER', 'ADMIN'))
    );

-- ----------------------------------------------------------------------------
-- 5. RLS POLICIES FOR USERS & BRANCH ACCESS
-- ----------------------------------------------------------------------------
CREATE POLICY users_select_policy ON users
    FOR SELECT USING (organization_id = auth_org_id());

CREATE POLICY users_manage_admin ON users
    FOR ALL USING (
        organization_id = auth_org_id() AND 
        EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('OWNER', 'ADMIN'))
    );

CREATE POLICY user_branch_access_select ON user_branch_access
    FOR SELECT USING (
        user_id = auth.uid() OR
        EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('OWNER', 'ADMIN'))
    );

-- ----------------------------------------------------------------------------
-- 6. RLS POLICIES FOR CUSTOMERS
-- ----------------------------------------------------------------------------
CREATE POLICY customers_all_policy ON customers
    FOR ALL USING (organization_id = auth_org_id())
    WITH CHECK (organization_id = auth_org_id());

-- ----------------------------------------------------------------------------
-- 7. RLS POLICIES FOR SERVICES
-- ----------------------------------------------------------------------------
CREATE POLICY services_select_policy ON services
    FOR SELECT USING (organization_id = auth_org_id());

CREATE POLICY services_manage_policy ON services
    FOR ALL USING (
        organization_id = auth_org_id() AND 
        EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('OWNER', 'ADMIN'))
    );

-- ----------------------------------------------------------------------------
-- 8. RLS POLICIES FOR CASHIER SHIFTS
-- ----------------------------------------------------------------------------
CREATE POLICY cashier_shifts_select ON cashier_shifts
    FOR SELECT USING (organization_id = auth_org_id() AND user_has_branch_access(branch_id));

CREATE POLICY cashier_shifts_insert ON cashier_shifts
    FOR INSERT WITH CHECK (
        organization_id = auth_org_id() 
        AND user_has_branch_access(branch_id)
        AND cashier_id = auth.uid()
    );

CREATE POLICY cashier_shifts_update ON cashier_shifts
    FOR UPDATE USING (
        organization_id = auth_org_id() 
        AND user_has_branch_access(branch_id)
    ) WITH CHECK (
        organization_id = auth_org_id() 
        AND user_has_branch_access(branch_id)
    );

-- ----------------------------------------------------------------------------
-- 9. RLS POLICIES FOR ORDERS (STRICTLY TENANT & BRANCH ISOLATED)
-- ----------------------------------------------------------------------------
CREATE POLICY orders_select_policy ON orders
    FOR SELECT USING (
        organization_id = auth_org_id() AND 
        (user_has_branch_access(branch_id) OR user_has_branch_access(production_branch_id))
    );

CREATE POLICY orders_insert_policy ON orders
    FOR INSERT WITH CHECK (
        organization_id = auth_org_id() 
        AND user_has_branch_access(branch_id)
        AND created_by = auth.uid()
    );

CREATE POLICY orders_update_policy ON orders
    FOR UPDATE USING (
        organization_id = auth_org_id() AND 
        (user_has_branch_access(branch_id) OR user_has_branch_access(production_branch_id))
    ) WITH CHECK (
        organization_id = auth_org_id() AND 
        (user_has_branch_access(branch_id) OR user_has_branch_access(production_branch_id))
    );

-- NOTE: Global read policy "orders_public_tracking_policy" (USING true) has been
-- REMOVED. Public customer tracking is strictly delegated to get_public_order_tracking() RPC.

-- ----------------------------------------------------------------------------
-- 10. RLS POLICIES FOR ORDER ITEMS
-- ----------------------------------------------------------------------------
CREATE POLICY order_items_all_policy ON order_items
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM orders o 
            WHERE o.id = order_items.order_id 
            AND o.organization_id = auth_org_id()
            AND (user_has_branch_access(o.branch_id) OR user_has_branch_access(o.production_branch_id))
        )
    );

-- ----------------------------------------------------------------------------
-- 11. RLS POLICIES FOR PAYMENTS (IMMUTABLE: INSERT & SELECT ONLY)
-- ----------------------------------------------------------------------------
CREATE POLICY payments_select_policy ON payments
    FOR SELECT USING (
        organization_id = auth_org_id() AND user_has_branch_access(branch_id)
    );

CREATE POLICY payments_insert_policy ON payments
    FOR INSERT WITH CHECK (
        organization_id = auth_org_id() 
        AND user_has_branch_access(branch_id)
        AND received_by = auth.uid()
    );
-- NO UPDATE or DELETE policies: Financial payments are strictly immutable!

-- ----------------------------------------------------------------------------
-- 12. RLS POLICIES FOR STATUS HISTORY & AUDIT LOGS (IMMUTABLE)
-- ----------------------------------------------------------------------------
CREATE POLICY order_status_history_select ON order_status_history
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM orders o 
            WHERE o.id = order_status_history.order_id 
            AND o.organization_id = auth_org_id()
        )
    );

CREATE POLICY order_status_history_insert ON order_status_history
    FOR INSERT WITH CHECK (changed_by = auth.uid());

CREATE POLICY audit_logs_select ON audit_logs
    FOR SELECT USING (
        organization_id = auth_org_id() AND
        EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('OWNER', 'ADMIN'))
    );

CREATE POLICY audit_logs_insert ON audit_logs
    FOR INSERT WITH CHECK (organization_id = auth_org_id());

-- ----------------------------------------------------------------------------
-- 13. ISOLATED PUBLIC TRACKING RPC (ZERO PII EXPOSURE)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_public_order_tracking(p_tracking_token TEXT)
RETURNS JSONB AS $$
DECLARE
    v_result JSONB;
BEGIN
    IF p_tracking_token IS NULL OR length(trim(p_tracking_token)) < 10 THEN
        RETURN NULL;
    END IF;

    SELECT jsonb_build_object(
        'order_number', o.order_number,
        'status', o.status,
        'operating_mode', o.operating_mode,
        'subtotal', o.subtotal,
        'discount_amount', o.discount_amount,
        'delivery_fee', o.delivery_fee,
        'final_amount', o.final_amount,
        'paid_amount', o.paid_amount,
        'remaining_amount', o.remaining_amount,
        'payment_status', o.payment_status,
        'promised_ready_at', o.promised_ready_at,
        'created_at', o.created_at,
        'branch_name', b.name,
        'branch_address', b.address,
        'branch_phone', b.phone,
        'items', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'service_name', oi.service_name_snap,
                'quantity_or_weight', oi.quantity_or_weight,
                'billable_weight', oi.billable_weight,
                'item_type', oi.item_type,
                'subtotal', oi.subtotal
            ))
            FROM order_items oi
            WHERE oi.order_id = o.id
        ), '[]'::jsonb)
    ) INTO v_result
    FROM orders o
    JOIN branches b ON b.id = o.branch_id
    WHERE o.tracking_token = p_tracking_token;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Grant execution to public / anon role
GRANT EXECUTE ON FUNCTION get_public_order_tracking(TEXT) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- 14. DATA INTEGRITY TRIGGERS (PRICE SNAPSHOT & FINANCIAL VALIDATORS)
-- ----------------------------------------------------------------------------

-- Enforce calculation of order_items subtotal and snap official catalog price
CREATE OR REPLACE FUNCTION trg_calculate_order_item_subtotal()
RETURNS TRIGGER AS $$
DECLARE
    v_catalog_price NUMERIC(12, 2);
BEGIN
    -- Pull canonical unit price from active catalog to prevent malicious client pricing
    SELECT base_price INTO v_catalog_price FROM services WHERE id = NEW.service_id;
    IF v_catalog_price IS NOT NULL THEN
        NEW.unit_price_snap := v_catalog_price;
    END IF;

    NEW.subtotal := ROUND(NEW.unit_price_snap * NEW.billable_weight, 2);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_item_subtotal_calc ON order_items;
CREATE TRIGGER trg_order_item_subtotal_calc
    BEFORE INSERT OR UPDATE ON order_items
    FOR EACH ROW
    EXECUTE FUNCTION trg_calculate_order_item_subtotal();

-- Enforce calculation of orders final_amount and remaining_amount
CREATE OR REPLACE FUNCTION trg_validate_order_totals()
RETURNS TRIGGER AS $$
DECLARE
    v_calculated_final NUMERIC(12, 2);
BEGIN
    v_calculated_final := GREATEST(0, NEW.subtotal - NEW.discount_amount + NEW.delivery_fee);
    IF NEW.final_amount <> v_calculated_final THEN
        NEW.final_amount := v_calculated_final;
    END IF;
    NEW.remaining_amount := GREATEST(0, NEW.final_amount - NEW.paid_amount);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_orders ON orders;
CREATE TRIGGER trg_validate_orders
    BEFORE INSERT OR UPDATE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION trg_validate_order_totals();

-- Automatically update orders.paid_amount, remaining_amount, and payment_status on payment insert
CREATE OR REPLACE FUNCTION trg_update_order_payment_totals()
RETURNS TRIGGER AS $$
DECLARE
    v_total_paid NUMERIC(12, 2);
    v_final_amount NUMERIC(12, 2);
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
    FROM payments
    WHERE order_id = NEW.order_id AND status = 'SUCCESS';

    SELECT final_amount INTO v_final_amount
    FROM orders
    WHERE id = NEW.order_id;

    UPDATE orders
    SET 
        paid_amount = v_total_paid,
        remaining_amount = GREATEST(0, v_final_amount - v_total_paid),
        payment_status = CASE 
            WHEN v_total_paid >= v_final_amount THEN 'PAID'::payment_status_enum
            WHEN v_total_paid > 0 THEN 'PARTIAL'::payment_status_enum
            ELSE 'UNPAID'::payment_status_enum
        END,
        updated_at = NOW()
    WHERE id = NEW.order_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_payment_totals ON payments;
CREATE TRIGGER trg_order_payment_totals
    AFTER INSERT ON payments
    FOR EACH ROW
    EXECUTE FUNCTION trg_update_order_payment_totals();

-- Protect closed cashier shifts from being tampered with
CREATE OR REPLACE FUNCTION trg_prevent_closed_shift_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'CLOSED' THEN
        RAISE EXCEPTION 'Cannot modify or re-open a CLOSED cashier shift. Shift is audit-locked.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_closed_shifts ON cashier_shifts;
CREATE TRIGGER trg_protect_closed_shifts
    BEFORE UPDATE OR DELETE ON cashier_shifts
    FOR EACH ROW
    EXECUTE FUNCTION trg_prevent_closed_shift_mutation();
