-- ============================================================================
-- 001_initial_schema.sql
-- LaundryFlow SaaS: Core Relational Database Schema with High-Integrity Constraints
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- ENUM TYPES
-- ----------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE user_role_enum AS ENUM (
        'OWNER', 'ADMIN', 'MANAGER', 'BRANCH_MANAGER', 'CASHIER', 'OPERATOR', 'DRIVER', 'VIEWER'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE branch_type_enum AS ENUM (
        'OUTLET', 'CENTRAL_PRODUCTION', 'HYBRID'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE service_unit_enum AS ENUM (
        'KG', 'PCS', 'SET', 'METER', 'OTHER'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE rounding_rule_enum AS ENUM (
        'EXACT', 'ROUND_HALF_UP_0_5', 'CEIL_1_0', 'FLOOR'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE order_status_enum AS ENUM (
        'DRAFT', 'RECEIVED', 'SORTING', 'WASHING', 'DRYING', 
        'IRONING', 'PACKING', 'QC', 'READY', 'PICKED_UP', 'DELIVERED', 'COMPLETED', 'CANCELLED'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE payment_status_enum AS ENUM (
        'UNPAID', 'PARTIAL', 'PAID', 'REFUNDED'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE payment_method_enum AS ENUM (
        'CASH', 'BANK_TRANSFER', 'QRIS_MANUAL', 'EDC', 'OTHER'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE shift_status_enum AS ENUM (
        'OPEN', 'CLOSED', 'RECONCILED'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ----------------------------------------------------------------------------
-- 1. ORGANIZATIONS (TENANT BOUNDARY)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    slug VARCHAR(60) NOT NULL UNIQUE,
    subscription_tier VARCHAR(30) NOT NULL DEFAULT 'FREE',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 2. BRANCHES (OUTLETS & WORKSHOPS)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    code VARCHAR(10) NOT NULL,
    name VARCHAR(150) NOT NULL,
    branch_type branch_type_enum NOT NULL DEFAULT 'OUTLET',
    address TEXT,
    phone VARCHAR(25),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, code)
);

-- ----------------------------------------------------------------------------
-- 3. USERS (PROFILES TIED TO AUTH)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY, -- references auth.users(id) in Supabase
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    email VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    role user_role_enum NOT NULL DEFAULT 'CASHIER',
    default_branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 4. USER BRANCH ACCESS (MULTI-BRANCH MAPPING)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_branch_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, branch_id)
);

-- ----------------------------------------------------------------------------
-- 5. CUSTOMERS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    whatsapp VARCHAR(30),
    address TEXT,
    notes TEXT,
    membership_tier VARCHAR(30) DEFAULT 'REGULAR',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_org_phone ON customers(organization_id, phone);
CREATE INDEX IF NOT EXISTS idx_customers_org_name ON customers(organization_id, name);

-- ----------------------------------------------------------------------------
-- 6. SERVICES (PRICING & CATALOG)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    name VARCHAR(150) NOT NULL,
    category VARCHAR(50) NOT NULL,
    unit service_unit_enum NOT NULL DEFAULT 'KG',
    base_price NUMERIC(12, 2) NOT NULL CHECK (base_price >= 0),
    min_charge_unit NUMERIC(6, 2) NOT NULL DEFAULT 1.0 CHECK (min_charge_unit >= 0),
    rounding_rule rounding_rule_enum NOT NULL DEFAULT 'EXACT',
    estimated_duration_hours INT NOT NULL DEFAULT 48,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_services_org ON services(organization_id, is_active);

-- ----------------------------------------------------------------------------
-- 7. CASHIER SHIFTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cashier_shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    cashier_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    opening_cash NUMERIC(12, 2) NOT NULL DEFAULT 0.0 CHECK (opening_cash >= 0),
    expected_cash NUMERIC(12, 2) NOT NULL DEFAULT 0.0,
    actual_cash NUMERIC(12, 2),
    difference NUMERIC(12, 2),
    status shift_status_enum NOT NULL DEFAULT 'OPEN',
    notes TEXT,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    closed_by UUID REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_shifts_branch_status ON cashier_shifts(branch_id, status);

-- ----------------------------------------------------------------------------
-- 8. ORDERS (CORE TRANSACTION)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    production_branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    order_number VARCHAR(30) NOT NULL,
    tracking_token VARCHAR(48) NOT NULL UNIQUE,
    status order_status_enum NOT NULL DEFAULT 'RECEIVED',
    operating_mode VARCHAR(20) NOT NULL DEFAULT 'SIMPLE',
    subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0.0 CHECK (subtotal >= 0),
    discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0 CHECK (discount_amount >= 0),
    delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0.0 CHECK (delivery_fee >= 0),
    final_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0 CHECK (final_amount >= 0),
    paid_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0 CHECK (paid_amount >= 0),
    remaining_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.0 CHECK (remaining_amount >= 0),
    payment_status payment_status_enum NOT NULL DEFAULT 'UNPAID',
    notes TEXT,
    promised_ready_at TIMESTAMPTZ NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, order_number)
);

CREATE INDEX IF NOT EXISTS idx_orders_org_branch_status ON orders(organization_id, branch_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_tracking ON orders(tracking_token);

-- ----------------------------------------------------------------------------
-- 9. ORDER ITEMS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
    item_type VARCHAR(20) NOT NULL DEFAULT 'KILOAN',
    service_name_snap VARCHAR(150) NOT NULL,
    unit_price_snap NUMERIC(12, 2) NOT NULL CHECK (unit_price_snap >= 0),
    quantity_or_weight NUMERIC(8, 2) NOT NULL CHECK (quantity_or_weight > 0),
    billable_weight NUMERIC(8, 2) NOT NULL CHECK (billable_weight > 0),
    subtotal NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- ----------------------------------------------------------------------------
-- 10. PAYMENTS (IMMUTABLE AUDITED TRANSACTIONS)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    cashier_shift_id UUID REFERENCES cashier_shifts(id) ON DELETE RESTRICT,
    payment_method payment_method_enum NOT NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    reference_number VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'SUCCESS',
    received_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_shift ON payments(cashier_shift_id);

-- ----------------------------------------------------------------------------
-- 11. ORDER STATUS HISTORY (IMMUTABLE STAGE LOG)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    from_status order_status_enum,
    to_status order_status_enum NOT NULL,
    changed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_history_order ON order_status_history(order_id);

-- ----------------------------------------------------------------------------
-- 12. AUDIT LOGS (IMMUTABLE FORENSIC LOG)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(60) NOT NULL,
    entity_type VARCHAR(60) NOT NULL,
    entity_id UUID NOT NULL,
    before_data JSONB,
    after_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_entity ON audit_logs(organization_id, entity_type, entity_id);
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
-- ============================================================================
-- 003_seed_demo_data.sql
-- LaundryFlow SaaS: Demo Sandbox Seed Data for "Laundry Sejahtera Group"
-- ============================================================================

-- Fixed UUIDs for deterministic reference
DO $$
DECLARE
    v_org_id UUID := '11111111-1111-1111-1111-111111111111';
    v_branch_bekasi UUID := '22222222-2222-2222-2222-222222222221';
    v_branch_tambun UUID := '22222222-2222-2222-2222-222222222222';
    v_central_prod UUID := '22222222-2222-2222-2222-222222222223';
    
    v_user_owner UUID := '33333333-3333-3333-3333-333333333331';
    v_user_cashier UUID := '33333333-3333-3333-3333-333333333332';
    v_user_operator UUID := '33333333-3333-3333-3333-333333333333';

    v_svc_kiloan_reg UUID := '44444444-4444-4444-4444-444444444441';
    v_svc_kiloan_exp UUID := '44444444-4444-4444-4444-444444444442';
    v_svc_bedcover_king UUID := '44444444-4444-4444-4444-444444444443';
    v_svc_jas UUID := '44444444-4444-4444-4444-444444444444';
    v_svc_sepatu UUID := '44444444-4444-4444-4444-444444444445';

    v_cust_budi UUID := '55555555-5555-5555-5555-555555555551';
    v_cust_siti UUID := '55555555-5555-5555-5555-555555555552';
    v_cust_agus UUID := '55555555-5555-5555-5555-555555555553';
    v_cust_dewi UUID := '55555555-5555-5555-5555-555555555554';

    v_shift_id UUID := '66666666-6666-6666-6666-666666666661';
    v_order_1 UUID := '77777777-7777-7777-7777-777777777771';
    v_order_2 UUID := '77777777-7777-7777-7777-777777777772';
BEGIN

    -- 1. Insert Organization
    INSERT INTO organizations (id, name, slug, subscription_tier, status)
    VALUES (v_org_id, 'Laundry Sejahtera Group', 'laundry-sejahtera', 'ENTERPRISE_DEMO', 'ACTIVE')
    ON CONFLICT (id) DO NOTHING;

    -- 2. Insert Branches (2 Retail Outlets + 1 Central Production)
    INSERT INTO branches (id, organization_id, code, name, branch_type, address, phone, is_active)
    VALUES 
        (v_branch_bekasi, v_org_id, 'BKS-01', 'Outlet Bekasi Timur', 'OUTLET', 'Jl. Juanda No. 88, Bekasi Timur', '081299887711', TRUE),
        (v_branch_tambun, v_org_id, 'TBN-01', 'Outlet Tambun Selatan', 'OUTLET', 'Jl. Sultan Hasanudin No. 45, Tambun', '081299887722', TRUE),
        (v_central_prod, v_org_id, 'CP-01', 'Central Production Unit Tambun', 'CENTRAL_PRODUCTION', 'Kawasan Industri Tambun Blok C', '081299887733', TRUE)
    ON CONFLICT (id) DO NOTHING;

    -- 3. Insert Demo Users (Mocking Auth Profile)
    INSERT INTO users (id, organization_id, email, full_name, role, default_branch_id, is_active)
    VALUES 
        (v_user_owner, v_org_id, 'owner@demo.laundryflow.id', 'Pak Haji Hendra (Owner)', 'OWNER', v_branch_bekasi, TRUE),
        (v_user_cashier, v_org_id, 'kasir@demo.laundryflow.id', 'Rina Kasir (Bekasi)', 'CASHIER', v_branch_bekasi, TRUE),
        (v_user_operator, v_org_id, 'operator@demo.laundryflow.id', 'Joko Operator (Central)', 'OPERATOR', v_central_prod, TRUE)
    ON CONFLICT (id) DO NOTHING;

    -- User Branch Access
    INSERT INTO user_branch_access (user_id, branch_id)
    VALUES 
        (v_user_owner, v_branch_bekasi),
        (v_user_owner, v_branch_tambun),
        (v_user_owner, v_central_prod),
        (v_user_cashier, v_branch_bekasi),
        (v_user_operator, v_central_prod)
    ON CONFLICT (user_id, branch_id) DO NOTHING;

    -- 4. Insert Services
    INSERT INTO services (id, organization_id, name, category, unit, base_price, min_charge_unit, rounding_rule, estimated_duration_hours, is_active)
    VALUES 
        (v_svc_kiloan_reg, v_org_id, 'Cuci Komplit Reguler (Cuci + Kering + Setrika)', 'Kiloan', 'KG', 8000.00, 3.00, 'ROUND_HALF_UP_0_5', 48, TRUE),
        (v_svc_kiloan_exp, v_org_id, 'Cuci Komplit Express 6 Jam', 'Kiloan', 'KG', 15000.00, 3.00, 'ROUND_HALF_UP_0_5', 6, TRUE),
        (v_svc_bedcover_king, v_org_id, 'Bed Cover King Size', 'Satuan', 'PCS', 35000.00, 1.00, 'EXACT', 48, TRUE),
        (v_svc_jas, v_org_id, 'Jas Formal 2-Piece', 'Satuan', 'SET', 40000.00, 1.00, 'EXACT', 72, TRUE),
        (v_svc_sepatu, v_org_id, 'Deep Clean Sepatu Sneakers', 'Satuan', 'PCS', 35000.00, 1.00, 'EXACT', 48, TRUE)
    ON CONFLICT (id) DO NOTHING;

    -- 5. Insert Customers
    INSERT INTO customers (id, organization_id, name, phone, whatsapp, address, membership_tier)
    VALUES 
        (v_cust_budi, v_org_id, 'Budi Santoso', '081234567890', '081234567890', 'Perumahan Grand Galaxy City Blok B2 No. 10', 'REGULAR'),
        (v_cust_siti, v_org_id, 'Siti Rahmawati', '085712345678', '085712345678', 'Apartemen Lagoon Resort Tower A 12-05', 'VIP'),
        (v_cust_agus, v_org_id, 'Agus Prasetyo', '087812345678', '087812345678', 'Jl. Melati Raya No. 15, Bekasi', 'REGULAR'),
        (v_cust_dewi, v_org_id, 'Dewi Lestari', '089612345678', '089612345678', 'Perumahan Kemang Pratama 2 Blok C1', 'VIP')
    ON CONFLICT (id) DO NOTHING;

    -- 6. Insert Cashier Shift (Active Shift)
    INSERT INTO cashier_shifts (id, organization_id, branch_id, cashier_id, opening_cash, expected_cash, status, opened_at)
    VALUES (v_shift_id, v_org_id, v_branch_bekasi, v_user_cashier, 150000.00, 150000.00, 'OPEN', NOW() - INTERVAL '4 hours')
    ON CONFLICT (id) DO NOTHING;

    -- 7. Insert Sample Orders
    -- Order 1: Kiloan Reguler (4.2 KG -> rounded to 4.5 KG billable)
    INSERT INTO orders (
        id, organization_id, branch_id, production_branch_id, customer_id, 
        order_number, tracking_token, status, operating_mode, 
        subtotal, discount_amount, delivery_fee, final_amount, paid_amount, remaining_amount, 
        payment_status, promised_ready_at, created_by
    ) VALUES (
        v_order_1, v_org_id, v_branch_bekasi, v_central_prod, v_cust_budi,
        'BKS-2609-0001', 'trk_live_bks01_budi9988', 'WASHING', 'ADVANCED',
        36000.00, 0.00, 0.00, 36000.00, 36000.00, 0.00,
        'PAID', NOW() + INTERVAL '24 hours', v_user_cashier
    ) ON CONFLICT (id) DO NOTHING;

    INSERT INTO order_items (
        order_id, service_id, item_type, service_name_snap, 
        unit_price_snap, quantity_or_weight, billable_weight, subtotal, notes
    ) VALUES (
        v_order_1, v_svc_kiloan_reg, 'KILOAN', 'Cuci Komplit Reguler (Cuci + Kering + Setrika)',
        8000.00, 4.20, 4.50, 36000.00, 'Pewangi Lavender, pisahkan baju putih'
    ) ON CONFLICT DO NOTHING;

    INSERT INTO payments (
        organization_id, branch_id, order_id, cashier_shift_id,
        payment_method, amount, status, received_by
    ) VALUES (
        v_org_id, v_branch_bekasi, v_order_1, v_shift_id,
        'CASH', 36000.00, 'SUCCESS', v_user_cashier
    ) ON CONFLICT DO NOTHING;

    INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, notes)
    VALUES 
        (v_order_1, NULL, 'RECEIVED', v_user_cashier, 'Diterima di Outlet Bekasi Timur'),
        (v_order_1, 'RECEIVED', 'WASHING', v_user_operator, 'Sedang dicuci di Central Production Tambun')
    ON CONFLICT DO NOTHING;

    -- Order 2: Ready for Pickup (Satuan Bed Cover + Kiloan Express)
    INSERT INTO orders (
        id, organization_id, branch_id, production_branch_id, customer_id, 
        order_number, tracking_token, status, operating_mode, 
        subtotal, discount_amount, delivery_fee, final_amount, paid_amount, remaining_amount, 
        payment_status, promised_ready_at, created_by
    ) VALUES (
        v_order_2, v_org_id, v_branch_bekasi, v_branch_bekasi, v_cust_siti,
        'BKS-2609-0002', 'trk_live_bks01_siti7721', 'READY', 'SIMPLE',
        80000.00, 0.00, 0.00, 80000.00, 80000.00, 0.00,
        'PAID', NOW() - INTERVAL '2 hours', v_user_cashier
    ) ON CONFLICT (id) DO NOTHING;

    INSERT INTO order_items (
        order_id, service_id, item_type, service_name_snap, 
        unit_price_snap, quantity_or_weight, billable_weight, subtotal, notes
    ) VALUES 
        (v_order_2, v_svc_bedcover_king, 'SATUAN', 'Bed Cover King Size', 35000.00, 1.00, 1.00, 35000.00, 'Warna biru tua'),
        (v_order_2, v_svc_kiloan_exp, 'KILOAN', 'Cuci Komplit Express 6 Jam', 15000.00, 3.00, 3.00, 45000.00, 'Kemeja kantor')
    ON CONFLICT DO NOTHING;

    INSERT INTO payments (
        organization_id, branch_id, order_id, cashier_shift_id,
        payment_method, amount, reference_number, status, received_by
    ) VALUES (
        v_org_id, v_branch_bekasi, v_order_2, v_shift_id,
        'QRIS_MANUAL', 80000.00, 'QRIS-BCA-20260917-8899', 'SUCCESS', v_user_cashier
    ) ON CONFLICT DO NOTHING;

    INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, notes)
    VALUES 
        (v_order_2, NULL, 'RECEIVED', v_user_cashier, 'Nota Masuk'),
        (v_order_2, 'RECEIVED', 'READY', v_user_cashier, 'Selesai & sudah di packing rapi di rak A-03')
    ON CONFLICT DO NOTHING;

END $$;
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
-- ============================================================================
-- 009_multi_cycle_rework_gate.sql
-- LAUNDRYFLOW SAAS â€” MULTI-CYCLE TRANSIT & REWORK GATE ENFORCEMENT
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
-- ============================================================================
-- 010_production_domain.sql
-- LAUNDRYFLOW SAAS â€” PRODUCTION DOMAIN SCHEMA, IMMUTABILITY & RPCS
--
-- Preserves:
-- 1. Model C: orders.branch_id = permanent commercial origin (IMMUTABLE)
-- 2. orders.production_branch_id = designated fulfillment workshop
-- 3. orders.status = commercial milestone (WASHING as compatibility projection)
-- 4. Multi-Cycle Rework: 1 CONSUMED token = at most 1 rework ProductionJob
-- 5. Strict Separation: Transit DAMAGED != Production QC_FAIL
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. SERVICE WORKFLOW CONFIGURATION (SAFE NON-SILENT MIGRATION)
-- ----------------------------------------------------------------------------

-- Step 1: Add standard_stages column as nullable
ALTER TABLE services ADD COLUMN IF NOT EXISTS standard_stages TEXT[] NULL;

-- Step 2: Explicitly map known services based on verified catalog records
-- A. Shoes / Sneakers: Deep Clean + Controlled Drying (NO IRONING)
UPDATE services 
SET standard_stages = ARRAY['WASHING', 'DRYING', 'PACKED']
WHERE category ILIKE '%Sepatu%' OR name ILIKE '%Sepatu%' OR name ILIKE '%Sneakers%';

-- B. Setrika Saja (Ironing Only)
UPDATE services 
SET standard_stages = ARRAY['IRONING', 'PACKED']
WHERE name ILIKE '%Setrika Saja%' OR name ILIKE '%Setrika%';

-- C. Standard Full Wash Services (Kiloan Komplit, Bed Cover, Jas Formal, etc.)
UPDATE services 
SET standard_stages = ARRAY['WASHING', 'DRYING', 'IRONING', 'PACKED']
WHERE (category = 'Kiloan' OR name ILIKE '%Komplit%' OR name ILIKE '%Bed Cover%' OR name ILIKE '%Jas%')
  AND standard_stages IS NULL;

-- Step 3: Failsafe Migration Assertion (Guarantees zero silent guessing)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM services WHERE standard_stages IS NULL) THEN
        RAISE EXCEPTION 'Migration 010 failed: One or more services could not be mapped to standard_stages. Manual workflow definition required.';
    END IF;
END $$;

-- Step 4: Token Check Constraint (Allowed tokens and terminal PACKED requirement)
ALTER TABLE services DROP CONSTRAINT IF EXISTS chk_services_valid_stages;
ALTER TABLE services ADD CONSTRAINT chk_services_valid_stages
CHECK (
    standard_stages <@ ARRAY['WASHING', 'DRYING', 'IRONING', 'PACKED', 'SPECIAL_TREATMENT']::TEXT[]
    AND array_length(standard_stages, 1) >= 1
    AND standard_stages[array_length(standard_stages, 1)] = 'PACKED'
);

-- Step 5: Enforce NOT NULL and define default for future service catalog creations
ALTER TABLE services ALTER COLUMN standard_stages SET NOT NULL;
ALTER TABLE services ALTER COLUMN standard_stages SET DEFAULT ARRAY['WASHING', 'DRYING', 'IRONING', 'PACKED'];

-- ----------------------------------------------------------------------------
-- 2. ENUM TYPES FOR PRODUCTION DOMAIN
-- ----------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE production_job_status_enum AS ENUM (
        'IN_PROGRESS', 'COMPLETED', 'CANCELLED'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE work_item_status_enum AS ENUM (
        'IN_PROGRESS', 'SPLIT', 'COMPLETED', 'CANCELLED'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE stage_transition_type_enum AS ENUM (
        'START', 'ADVANCE', 'QC_PASS', 'QC_FAIL', 'SPLIT', 'CANCEL'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE split_reason_enum AS ENUM (
        'CAPACITY_OVERFLOW', 'QC_DEFECT_ISOLATION', 'TREATMENT_SEGREGATION'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;


-- ----------------------------------------------------------------------------
-- 3. TABLE: production_jobs
-- Root of manufacturing execution per order fulfillment cycle
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    order_id UUID NOT NULL,
    branch_id UUID NOT NULL,
    rework_request_id UUID NULL REFERENCES order_rework_requests(id) ON DELETE RESTRICT,
    status production_job_status_enum NOT NULL DEFAULT 'IN_PROGRESS',
    notes TEXT NULL,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ NULL,
    completed_by UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
    cancelled_at TIMESTAMPTZ NULL,
    cancelled_by UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Composite Foreign Keys enforcing multi-tenant and branch alignment
    CONSTRAINT fk_prod_job_order FOREIGN KEY (order_id, organization_id) 
        REFERENCES orders(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT fk_prod_job_branch FOREIGN KEY (branch_id, organization_id) 
        REFERENCES branches(id, organization_id) ON DELETE RESTRICT
);

-- Partial Unique Indexes for Strict Cycle Identity
-- Invariant: Exactly 1 initial job (Cycle 1) per order
CREATE UNIQUE INDEX IF NOT EXISTS idx_production_jobs_initial_unique 
ON production_jobs(order_id) 
WHERE rework_request_id IS NULL;

-- Invariant: Exactly 1 rework job per consumed rework authorization token
CREATE UNIQUE INDEX IF NOT EXISTS idx_production_jobs_rework_unique 
ON production_jobs(rework_request_id) 
WHERE rework_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_production_jobs_org_branch_status 
ON production_jobs(organization_id, branch_id, status);

CREATE INDEX IF NOT EXISTS idx_production_jobs_order 
ON production_jobs(order_id);

-- ----------------------------------------------------------------------------
-- 4. TABLE: production_work_items
-- Physical laundry bundle items with single-level split lineage
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_work_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES production_jobs(id) ON DELETE RESTRICT,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
    service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
    parent_item_id UUID NULL REFERENCES production_work_items(id) ON DELETE RESTRICT,
    item_code VARCHAR(40) NOT NULL,
    service_name_snap VARCHAR(150) NOT NULL,
    unit service_unit_enum NOT NULL,
    quantity NUMERIC(8, 2) NOT NULL CHECK (quantity > 0),
    service_stages TEXT[] NOT NULL,
    current_stage TEXT NOT NULL,
    stage_index INT NOT NULL DEFAULT 1 CHECK (stage_index >= 1),
    status work_item_status_enum NOT NULL DEFAULT 'IN_PROGRESS',
    split_reason split_reason_enum NULL,
    notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Integer unit constraint (PCS and SET must be whole integer quantities)
    CONSTRAINT chk_work_item_integer_units CHECK (
        unit NOT IN ('PCS', 'SET') OR quantity = ROUND(quantity, 0)
    ),

    -- Valid stages constraint (must be subset of valid production stages)
    CONSTRAINT chk_work_item_stages_valid CHECK (
        service_stages <@ ARRAY['WASHING', 'DRYING', 'IRONING', 'PACKED', 'SPECIAL_TREATMENT']::TEXT[]
        AND array_length(service_stages, 1) >= 1
    ),

    -- Split reason invariant: root items have NULL split_reason, child items must have valid split_reason
    CONSTRAINT chk_work_item_split_reason CHECK (
        (parent_item_id IS NULL AND split_reason IS NULL) OR
        (parent_item_id IS NOT NULL AND split_reason IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_work_items_job_status ON production_work_items(job_id, status);
CREATE INDEX IF NOT EXISTS idx_work_items_order_item ON production_work_items(order_item_id);
CREATE INDEX IF NOT EXISTS idx_work_items_parent ON production_work_items(parent_item_id);
CREATE INDEX IF NOT EXISTS idx_work_items_org ON production_work_items(organization_id);

-- ----------------------------------------------------------------------------
-- 5. TABLE: production_stage_logs
-- Append-only immutable transition, advance, split, and QC audit trail
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_stage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_item_id UUID NOT NULL REFERENCES production_work_items(id) ON DELETE RESTRICT,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    from_stage TEXT NULL,
    to_stage TEXT NOT NULL,
    transition_type stage_transition_type_enum NOT NULL,
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stage_logs_work_item ON production_stage_logs(work_item_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_stage_logs_org ON production_stage_logs(organization_id);

-- ----------------------------------------------------------------------------
-- 6. IMMUTABILITY, CUSTODY & INTEGRITY TRIGGERS
-- ----------------------------------------------------------------------------

-- A. Enforce Production Job Invariants, Terminal Immutability & Physical Custody
CREATE OR REPLACE FUNCTION trg_enforce_production_job_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_order_branch UUID;
    v_order_prod_branch UUID;
    v_order_org UUID;
    v_has_custody BOOLEAN;
BEGIN
    -- 1. Core composite key immutability on UPDATE
    IF TG_OP = 'UPDATE' THEN
        IF OLD.id <> NEW.id OR OLD.organization_id <> NEW.organization_id OR 
           OLD.order_id <> NEW.order_id OR OLD.branch_id <> NEW.branch_id OR 
           OLD.rework_request_id IS DISTINCT FROM NEW.rework_request_id THEN
            RAISE EXCEPTION 'Illegal mutation: Core identity keys of production job % are immutable.', OLD.id;
        END IF;

        -- Terminal state immutability
        IF OLD.status IN ('COMPLETED', 'CANCELLED') AND NEW.status <> OLD.status THEN
            RAISE EXCEPTION 'Illegal state transition: Production job % is % and cannot be transitioned to %.',
                OLD.id, OLD.status, NEW.status;
        END IF;

        RETURN NEW;
    END IF;

    -- 2. INSERT: Validate tenant and workshop branch invariants against orders table
    SELECT organization_id, branch_id, production_branch_id 
    INTO v_order_org, v_order_branch, v_order_prod_branch
    FROM orders 
    WHERE id = NEW.order_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Order % does not exist.', NEW.order_id;
    END IF;

    IF NEW.organization_id <> v_order_org THEN
        RAISE EXCEPTION 'Tenant mismatch: Job org % does not match order org %.', NEW.organization_id, v_order_org;
    END IF;

    IF NEW.branch_id <> v_order_prod_branch THEN
        RAISE EXCEPTION 'Branch invariant violation: Job branch % must match order production_branch_id %.',
            NEW.branch_id, v_order_prod_branch;
    END IF;

    -- 3. INSERT: Physical Custody Prerequisite Enforcement
    -- Central Production: Requires verified Outbound Transit received with RECEIVED_OK
    IF v_order_branch <> v_order_prod_branch THEN
        SELECT EXISTS (
            SELECT 1 
            FROM transit_manifest_items tmi
            JOIN transit_manifests tm ON tm.id = tmi.manifest_id
            WHERE tmi.order_id = NEW.order_id
              AND tm.source_branch_id = v_order_branch
              AND tm.destination_branch_id = v_order_prod_branch
              AND tm.status = 'RECEIVED'
              AND tmi.received_status = 'RECEIVED_OK'
              -- Custody is at workshop: no subsequent return transit completed
              AND NOT EXISTS (
                  SELECT 1
                  FROM transit_manifest_items tmi_ret
                  JOIN transit_manifests tm_ret ON tm_ret.id = tmi_ret.manifest_id
                  WHERE tmi_ret.order_id = NEW.order_id
                    AND tm_ret.source_branch_id = v_order_prod_branch
                    AND tm_ret.destination_branch_id = v_order_branch
                    AND tm_ret.status = 'RECEIVED'
                    AND tmi_ret.received_status = 'RECEIVED_OK'
                    AND tm_ret.received_at >= tm.received_at
              )
        ) INTO v_has_custody;

        IF NOT v_has_custody THEN
            RAISE EXCEPTION 'Physical custody violation: Order % has not physically arrived at workshop % via outbound transit.',
                NEW.order_id, NEW.branch_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_production_job_invariants ON production_jobs;
CREATE TRIGGER trg_production_job_invariants
    BEFORE INSERT OR UPDATE ON production_jobs
    FOR EACH ROW
    EXECUTE FUNCTION trg_enforce_production_job_invariants();

-- B. Enforce Work Item Immutability & Single-Level Split Lineage Depth
CREATE OR REPLACE FUNCTION trg_enforce_work_item_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_parent_of_parent UUID;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Core keys immutability
        IF OLD.id <> NEW.id OR OLD.job_id <> NEW.job_id OR OLD.organization_id <> NEW.organization_id OR
           OLD.order_item_id <> NEW.order_item_id OR OLD.service_id <> NEW.service_id OR
           OLD.parent_item_id IS DISTINCT FROM NEW.parent_item_id OR OLD.unit <> NEW.unit OR
           OLD.service_stages <> NEW.service_stages OR
           OLD.split_reason IS DISTINCT FROM NEW.split_reason THEN
            RAISE EXCEPTION 'Illegal mutation: Core snapshot keys of work item % are immutable.', OLD.id;
        END IF;

        -- Terminal work items cannot be modified
        IF OLD.status IN ('COMPLETED', 'CANCELLED', 'SPLIT') AND NEW.status <> OLD.status THEN
            RAISE EXCEPTION 'Illegal state transition: Work item % is % and cannot be transitioned to %.',
                OLD.id, OLD.status, NEW.status;
        END IF;

        RETURN NEW;
    END IF;

    -- INSERT: Single-level split depth constraint (ROOT -> CHILD only, NO GRANDCHILDREN)
    IF NEW.parent_item_id IS NOT NULL THEN
        SELECT parent_item_id INTO v_parent_of_parent
        FROM production_work_items
        WHERE id = NEW.parent_item_id;

        IF v_parent_of_parent IS NOT NULL THEN
            RAISE EXCEPTION 'Split depth violation: Cannot split item % because it is already a child item. Maximum split depth is 1.',
                NEW.parent_item_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_item_invariants ON production_work_items;
CREATE TRIGGER trg_work_item_invariants
    BEFORE INSERT OR UPDATE ON production_work_items
    FOR EACH ROW
    EXECUTE FUNCTION trg_enforce_work_item_invariants();

-- C. Prevent Deletion on Work Items (Physical Lineage Protection)
CREATE OR REPLACE FUNCTION trg_prevent_work_item_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Illegal operation: Work item % cannot be deleted. Physical lineage and audit trail must be preserved.', OLD.id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_item_deletion_guard ON production_work_items;
CREATE TRIGGER trg_work_item_deletion_guard
    BEFORE DELETE ON production_work_items
    FOR EACH ROW
    EXECUTE FUNCTION trg_prevent_work_item_deletion();

-- D. Prevent Mutation and Deletion on Production Stage Logs (Append-Only Audit Trail)
CREATE OR REPLACE FUNCTION trg_prevent_stage_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Illegal operation: production_stage_logs is strictly immutable and cannot be modified or deleted.';
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_stage_log_mutation_guard ON production_stage_logs;
CREATE TRIGGER trg_stage_log_mutation_guard
    BEFORE UPDATE OR DELETE ON production_stage_logs
    FOR EACH ROW
    EXECUTE FUNCTION trg_prevent_stage_log_mutation();

-- ----------------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY (RLS) & DIRECT PRIVILEGE REVOCATION
-- ----------------------------------------------------------------------------
ALTER TABLE production_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_stage_logs ENABLE ROW LEVEL SECURITY;

-- SELECT Policies
DROP POLICY IF EXISTS production_jobs_select ON production_jobs;
CREATE POLICY production_jobs_select ON production_jobs
    FOR SELECT USING (
        organization_id = auth_org_id() AND (
            user_has_branch_access(branch_id) OR
            EXISTS (SELECT 1 FROM orders o WHERE o.id = production_jobs.order_id AND user_has_branch_access(o.branch_id))
        )
    );

DROP POLICY IF EXISTS production_work_items_select ON production_work_items;
CREATE POLICY production_work_items_select ON production_work_items
    FOR SELECT USING (
        organization_id = auth_org_id() AND
        EXISTS (
            SELECT 1 FROM production_jobs pj 
            WHERE pj.id = production_work_items.job_id
              AND (user_has_branch_access(pj.branch_id) OR 
                   EXISTS (SELECT 1 FROM orders o WHERE o.id = pj.order_id AND user_has_branch_access(o.branch_id)))
        )
    );

DROP POLICY IF EXISTS production_stage_logs_select ON production_stage_logs;
CREATE POLICY production_stage_logs_select ON production_stage_logs
    FOR SELECT USING (
        organization_id = auth_org_id() AND
        EXISTS (
            SELECT 1 FROM production_work_items pwi
            JOIN production_jobs pj ON pj.id = pwi.job_id
            WHERE pwi.id = production_stage_logs.work_item_id
              AND (user_has_branch_access(pj.branch_id) OR 
                   EXISTS (SELECT 1 FROM orders o WHERE o.id = pj.order_id AND user_has_branch_access(o.branch_id)))
        )
    );

-- HARD SECURITY GATE: Revoke direct mutation privileges from client roles
REVOKE ALL ON production_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON production_jobs TO authenticated;

REVOKE ALL ON production_work_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON production_work_items TO authenticated;

REVOKE ALL ON production_stage_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON production_stage_logs TO authenticated;

-- ----------------------------------------------------------------------------
-- 8. PRODUCTION COMPLETION CONTRACT FUNCTION
-- Internal narrow contract invoked exclusively by Transit Return Gate Trigger
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_order_production_complete(
    p_order_id UUID,
    p_workshop_branch_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_is_complete BOOLEAN := FALSE;
    v_latest_consumed_rework UUID;
    v_has_active_rework BOOLEAN;
BEGIN
    -- Verify order exists and designated production branch matches
    IF NOT EXISTS (
        SELECT 1 FROM public.orders o
        WHERE o.id = p_order_id 
          AND o.production_branch_id = p_workshop_branch_id
    ) THEN
        RETURN FALSE;
    END IF;

    -- Check if an active unconsumed rework token exists (order must undergo rework before return)
    SELECT EXISTS (
        SELECT 1 FROM public.order_rework_requests
        WHERE order_id = p_order_id
          AND status = 'APPROVED'
    ) INTO v_has_active_rework;

    IF v_has_active_rework THEN
        RETURN FALSE;
    END IF;

    -- Check for latest consumed rework request
    SELECT id INTO v_latest_consumed_rework
    FROM public.order_rework_requests
    WHERE order_id = p_order_id
      AND status = 'CONSUMED'
    ORDER BY consumed_at DESC LIMIT 1;

    -- If a rework cycle is consumed, verify that the rework job is COMPLETED
    IF v_latest_consumed_rework IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM public.production_jobs pj
            JOIN public.orders o ON o.id = pj.order_id AND o.organization_id = pj.organization_id
            WHERE pj.order_id = p_order_id
              AND pj.branch_id = p_workshop_branch_id
              AND pj.rework_request_id = v_latest_consumed_rework
              AND pj.status = 'COMPLETED'
        ) INTO v_is_complete;
    ELSE
        -- Initial production cycle (no rework consumed)
        SELECT EXISTS (
            SELECT 1 FROM public.production_jobs pj
            JOIN public.orders o ON o.id = pj.order_id AND o.organization_id = pj.organization_id
            WHERE pj.order_id = p_order_id
              AND pj.branch_id = p_workshop_branch_id
              AND pj.rework_request_id IS NULL
              AND pj.status = 'COMPLETED'
        ) INTO v_is_complete;
    END IF;

    RETURN COALESCE(v_is_complete, FALSE);
END;
$$;

-- Secure internal contract: REVOKE from PUBLIC, anon, and authenticated
REVOKE EXECUTE ON FUNCTION is_order_production_complete(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION is_order_production_complete(UUID, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION is_order_production_complete(UUID, UUID) FROM authenticated;

-- ----------------------------------------------------------------------------
-- 9. REVISE TRANSIT RETURN GATE TRIGGER FUNCTION (IN-PLACE REVISION)
-- Enforces: Return Transit requires Production Completion for RECEIVED_OK outbound
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_enforce_manifest_order_eligibility()
RETURNS TRIGGER 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
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
    v_latest_outbound_status manifest_item_status_enum;
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

    -- 5. DIRECTED ROUTE DETERMINATION & VALIDATION (Model C Contract + Multi-Cycle + Production Return Gate)
    
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

            -- Order has returned to origin (Cycle 1 complete). For Cycle 2+, require an APPROVED rework authorization
            IF NOT EXISTS (
                SELECT 1 FROM order_rework_requests
                WHERE order_id = NEW.order_id 
                  AND (status = 'APPROVED' OR (status = 'CONSUMED' AND consumed_manifest_id = NEW.manifest_id))
            ) THEN
                RAISE EXCEPTION 'Outbound route violation: Order % requires an active approved rework request for additional outbound transit.',
                    NEW.order_id;
            END IF;

            -- Consume the APPROVED token on Outbound dispatch
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
        SELECT tm_prev.received_at, tmi_prev.received_status
        INTO v_latest_outbound_received, v_latest_outbound_status
        FROM transit_manifest_items tmi_prev
        JOIN transit_manifests tm_prev ON tm_prev.id = tmi_prev.manifest_id
        WHERE tmi_prev.order_id = NEW.order_id
          AND tm_prev.source_branch_id = v_order_branch
          AND tm_prev.destination_branch_id = v_order_prod_branch
          AND tm_prev.status = 'RECEIVED'
          AND tmi_prev.received_status IN ('RECEIVED_OK', 'DAMAGED')
        ORDER BY tm_prev.received_at DESC LIMIT 1;

        IF v_latest_outbound_received IS NULL THEN
            RAISE EXCEPTION 'Return route violation: Order % cannot be returned from % to % because no prior RECEIVED outbound transit exists.',
                NEW.order_id, v_manifest_src, v_manifest_dest;
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

        -- PRODUCTION RETURN GATE:
        -- If outbound was RECEIVED_OK, production completion is strictly mandatory!
        -- If outbound was DAMAGED, production is bypassed under carrier exception.
        IF v_latest_outbound_status = 'RECEIVED_OK' THEN
            IF NOT is_order_production_complete(NEW.order_id, v_manifest_src) THEN
                RAISE EXCEPTION 'Return route violation: Order % cannot be returned because manufacturing is not complete at workshop %.',
                    NEW.order_id, v_manifest_src;
            END IF;
        END IF;

    -- Case C: NEITHER OUTBOUND NOR RETURN
    ELSE
        RAISE EXCEPTION 'Cross-branch violation: Order % (branch %, production %) is not eligible for manifest route % -> %.',
            NEW.order_id, v_order_branch, v_order_prod_branch, v_manifest_src, v_manifest_dest;
    END IF;

    RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. TRANSACTIONAL RPCS (SECURITY DEFINER WITH STRICT SEARCH_PATH)
-- ----------------------------------------------------------------------------

-- A. start_production_job
CREATE OR REPLACE FUNCTION start_production_job(
    p_order_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_user_role user_role_enum;
    v_org_id UUID;
    v_order orders%ROWTYPE;
    v_job_id UUID;
    v_existing_job_id UUID;
    v_rework_id UUID;
    v_item RECORD;
    v_work_item_id UUID;
    v_std_stages TEXT[];
    v_item_code VARCHAR(40);
    v_seq INT := 0;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required.';
    END IF;

    -- 1. Acquire exclusive row lock on target order
    SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Order % not found.', p_order_id;
    END IF;

    v_org_id := v_order.organization_id;

    -- 2. Validate user role and production branch access
    SELECT role INTO v_user_role FROM users WHERE id = v_user_id;
    IF v_user_role NOT IN ('OPERATOR', 'BRANCH_MANAGER', 'MANAGER', 'ADMIN', 'OWNER') THEN
        RAISE EXCEPTION 'Access denied: User role % is not authorized to start production.', v_user_role;
    END IF;

    IF NOT user_has_branch_access(v_order.production_branch_id) THEN
        RAISE EXCEPTION 'Access denied: Caller does not have access to production branch %.', v_order.production_branch_id;
    END IF;

    -- 3. Validate order status eligibility
    IF v_order.status IN ('CANCELLED', 'COMPLETED') THEN
        RAISE EXCEPTION 'Cannot start production on order % with terminal status %.', p_order_id, v_order.status;
    END IF;

    -- 4. Check active rework cycle token
    SELECT id INTO v_rework_id
    FROM order_rework_requests
    WHERE order_id = p_order_id AND status = 'CONSUMED'
    ORDER BY consumed_at DESC LIMIT 1;

    IF EXISTS (
        SELECT 1 FROM order_rework_requests 
        WHERE order_id = p_order_id AND status = 'APPROVED'
    ) THEN
        RAISE EXCEPTION 'Cannot start production: Order % has an APPROVED rework request that has not yet been consumed by outbound transit.', p_order_id;
    END IF;

    -- 5. Idempotency Check: if job already exists for this cycle, return existing job
    IF v_rework_id IS NOT NULL THEN
        SELECT id INTO v_existing_job_id 
        FROM production_jobs 
        WHERE rework_request_id = v_rework_id;
    ELSE
        SELECT id INTO v_existing_job_id 
        FROM production_jobs 
        WHERE order_id = p_order_id AND rework_request_id IS NULL;
    END IF;

    IF v_existing_job_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', true,
            'job_id', v_existing_job_id,
            'order_id', p_order_id,
            'created', false,
            'message', 'Production job already exists for this fulfillment cycle.'
        );
    END IF;

    -- 6. Insert new production job
    INSERT INTO production_jobs (
        organization_id,
        order_id,
        branch_id,
        rework_request_id,
        status,
        created_by,
        created_at
    ) VALUES (
        v_org_id,
        p_order_id,
        v_order.production_branch_id,
        v_rework_id,
        'IN_PROGRESS',
        v_user_id,
        NOW()
    ) RETURNING id INTO v_job_id;

    -- 7. Snapshot and generate work items from order_items
    FOR v_item IN 
        SELECT oi.id AS order_item_id, oi.service_id, oi.service_name_snap, oi.quantity_or_weight,
               s.unit, s.standard_stages
        FROM order_items oi
        JOIN services s ON s.id = oi.service_id
        WHERE oi.order_id = p_order_id
        ORDER BY oi.created_at ASC
    LOOP
        v_seq := v_seq + 1;
        v_item_code := v_order.order_number || '-ITM-' || LPAD(v_seq::text, 2, '0');
        v_std_stages := v_item.standard_stages;

        INSERT INTO production_work_items (
            job_id,
            organization_id,
            order_item_id,
            service_id,
            parent_item_id,
            item_code,
            service_name_snap,
            unit,
            quantity,
            service_stages,
            current_stage,
            stage_index,
            status,
            created_at
        ) VALUES (
            v_job_id,
            v_org_id,
            v_item.order_item_id,
            v_item.service_id,
            NULL,
            v_item_code,
            v_item.service_name_snap,
            v_item.unit,
            v_item.quantity_or_weight,
            v_std_stages,
            v_std_stages[1],
            1,
            'IN_PROGRESS',
            NOW()
        ) RETURNING id INTO v_work_item_id;

        -- Record initial stage log
        INSERT INTO production_stage_logs (
            work_item_id,
            organization_id,
            from_stage,
            to_stage,
            transition_type,
            actor_id,
            notes,
            created_at
        ) VALUES (
            v_work_item_id,
            v_org_id,
            NULL,
            v_std_stages[1],
            'START',
            v_user_id,
            'Production started at initial stage',
            NOW()
        );
    END LOOP;

    -- 8. Project commercial status to WASHING (if currently RECEIVED)
    IF v_order.status = 'RECEIVED' THEN
        UPDATE orders 
        SET status = 'WASHING', updated_at = NOW() 
        WHERE id = p_order_id;

        INSERT INTO order_status_history (
            order_id, from_status, to_status, changed_by, notes, created_at
        ) VALUES (
            p_order_id, 'RECEIVED', 'WASHING', v_user_id, 'Produksi dimulai di workshop', NOW()
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'job_id', v_job_id,
        'order_id', p_order_id,
        'created', true,
        'items_count', v_seq
    );
END;
$$;

-- B. advance_work_item_stage
CREATE OR REPLACE FUNCTION advance_work_item_stage(
    p_work_item_id UUID,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_item production_work_items%ROWTYPE;
    v_job production_jobs%ROWTYPE;
    v_next_stage TEXT;
    v_next_idx INT;
    v_is_terminal BOOLEAN := FALSE;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required.';
    END IF;

    SELECT * INTO v_item FROM production_work_items WHERE id = p_work_item_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Work item % not found.', p_work_item_id;
    END IF;

    SELECT * INTO v_job FROM production_jobs WHERE id = v_item.job_id FOR SHARE;
    IF v_job.status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'Cannot advance item: Parent production job % is %.', v_job.id, v_job.status;
    END IF;

    IF NOT user_has_branch_access(v_job.branch_id) THEN
        RAISE EXCEPTION 'Access denied for production branch %.', v_job.branch_id;
    END IF;

    IF v_item.status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'Cannot advance work item % with status %.', p_work_item_id, v_item.status;
    END IF;

    v_next_idx := v_item.stage_index + 1;
    IF v_next_idx > array_length(v_item.service_stages, 1) THEN
        RAISE EXCEPTION 'Work item % is already at terminal stage %.', p_work_item_id, v_item.current_stage;
    END IF;

    v_next_stage := v_item.service_stages[v_next_idx];
    IF v_next_idx = array_length(v_item.service_stages, 1) AND v_next_stage = 'PACKED' THEN
        v_is_terminal := TRUE;
    END IF;

    -- Update work item
    UPDATE production_work_items
    SET current_stage = v_next_stage,
        stage_index = v_next_idx,
        status = CASE WHEN v_is_terminal THEN 'COMPLETED'::work_item_status_enum ELSE 'IN_PROGRESS'::work_item_status_enum END,
        updated_at = NOW()
    WHERE id = p_work_item_id;

    -- Log stage transition
    INSERT INTO production_stage_logs (
        work_item_id,
        organization_id,
        from_stage,
        to_stage,
        transition_type,
        actor_id,
        notes,
        created_at
    ) VALUES (
        p_work_item_id,
        v_item.organization_id,
        v_item.current_stage,
        v_next_stage,
        'ADVANCE',
        v_user_id,
        COALESCE(p_notes, 'Tahapan produksi dilanjutkan'),
        NOW()
    );

    RETURN jsonb_build_object(
        'success', true,
        'work_item_id', p_work_item_id,
        'previous_stage', v_item.current_stage,
        'new_stage', v_next_stage,
        'is_completed', v_is_terminal
    );
END;
$$;

-- C. split_work_item
CREATE OR REPLACE FUNCTION split_work_item(
    p_work_item_id UUID,
    p_split_quantities NUMERIC[],
    p_split_reason split_reason_enum,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_parent production_work_items%ROWTYPE;
    v_job production_jobs%ROWTYPE;
    v_sum_qty NUMERIC(8, 2) := 0;
    v_qty NUMERIC(8, 2);
    v_child_id UUID;
    v_child_code VARCHAR(40);
    v_idx INT := 0;
    v_child_ids UUID[] := ARRAY[]::UUID[];
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required.';
    END IF;

    -- 1. Lock parent work item
    SELECT * INTO v_parent FROM production_work_items WHERE id = p_work_item_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Work item % not found.', p_work_item_id;
    END IF;

    -- 2. Lineage Depth Constraint: Parent MUST NOT be a child item (Maximum depth = 1)
    IF v_parent.parent_item_id IS NOT NULL THEN
        RAISE EXCEPTION 'Split depth violation: Cannot split item % because it is already a child item. Maximum split depth is 1.', p_work_item_id;
    END IF;

    IF v_parent.status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'Cannot split work item % with status %.', p_work_item_id, v_parent.status;
    END IF;

    SELECT * INTO v_job FROM production_jobs WHERE id = v_parent.job_id FOR SHARE;
    IF v_job.status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'Cannot split item: Parent job is %.', v_job.status;
    END IF;

    IF NOT user_has_branch_access(v_job.branch_id) THEN
        RAISE EXCEPTION 'Access denied for production branch %.', v_job.branch_id;
    END IF;

    -- 3. Validate split reason and quantities
    IF p_split_reason IS NULL THEN
        RAISE EXCEPTION 'Split operation requires a valid split_reason (CAPACITY_OVERFLOW, QC_DEFECT_ISOLATION, or TREATMENT_SEGREGATION).';
    END IF;

    IF p_split_quantities IS NULL OR array_length(p_split_quantities, 1) < 2 THEN
        RAISE EXCEPTION 'Split operation requires at least 2 child quantities.';
    END IF;

    FOREACH v_qty IN ARRAY p_split_quantities LOOP
        IF v_qty <= 0 THEN
            RAISE EXCEPTION 'Split quantity must be strictly greater than 0 (got %).', v_qty;
        END IF;

        IF v_parent.unit IN ('PCS', 'SET') AND v_qty <> ROUND(v_qty, 0) THEN
            RAISE EXCEPTION 'Integer unit violation: Unit % requires whole integer quantities.', v_parent.unit;
        END IF;

        v_sum_qty := v_sum_qty + v_qty;
    END LOOP;

    -- Exact conservation check: SUM(children) = parent
    IF v_sum_qty <> v_parent.quantity THEN
        RAISE EXCEPTION 'Quantity conservation violation: Sum of split parts (%) does not equal parent quantity (%).',
            v_sum_qty, v_parent.quantity;
    END IF;

    -- 4. Mark parent item as SPLIT (terminal non-completing)
    UPDATE production_work_items
    SET status = 'SPLIT',
        updated_at = NOW()
    WHERE id = p_work_item_id;

    -- 5. Insert child work items
    FOREACH v_qty IN ARRAY p_split_quantities LOOP
        v_idx := v_idx + 1;
        v_child_code := v_parent.item_code || '-S' || v_idx::text;

        INSERT INTO production_work_items (
            job_id,
            organization_id,
            order_item_id,
            service_id,
            parent_item_id,
            item_code,
            service_name_snap,
            unit,
            quantity,
            service_stages,
            current_stage,
            stage_index,
            status,
            split_reason,
            notes,
            created_at
        ) VALUES (
            v_parent.job_id,
            v_parent.organization_id,
            v_parent.order_item_id,
            v_parent.service_id,
            p_work_item_id,
            v_child_code,
            v_parent.service_name_snap,
            v_parent.unit,
            v_qty,
            v_parent.service_stages,
            v_parent.current_stage,
            v_parent.stage_index,
            'IN_PROGRESS',
            p_split_reason,
            'Split child from ' || v_parent.item_code || ' (' || p_split_reason::text || ')',
            NOW()
        ) RETURNING id INTO v_child_id;

        v_child_ids := array_append(v_child_ids, v_child_id);

        -- Record START stage log for child item
        INSERT INTO production_stage_logs (
            work_item_id,
            organization_id,
            from_stage,
            to_stage,
            transition_type,
            actor_id,
            notes,
            created_at
        ) VALUES (
            v_child_id,
            v_parent.organization_id,
            NULL,
            v_parent.current_stage,
            'START',
            v_user_id,
            'Child work item created via split (' || p_split_reason::text || ') from ' || v_parent.item_code,
            NOW()
        );
    END LOOP;

    -- Log SPLIT on parent item
    INSERT INTO production_stage_logs (
        work_item_id,
        organization_id,
        from_stage,
        to_stage,
        transition_type,
        actor_id,
        notes,
        created_at
    ) VALUES (
        p_work_item_id,
        v_parent.organization_id,
        v_parent.current_stage,
        v_parent.current_stage,
        'SPLIT',
        v_user_id,
        COALESCE(p_notes, 'Item di-split menjadi ' || v_idx::text || ' bagian. Alasan: ' || p_split_reason::text),
        NOW()
    );

    RETURN jsonb_build_object(
        'success', true,
        'parent_item_id', p_work_item_id,
        'child_item_ids', v_child_ids,
        'parts_count', v_idx,
        'split_reason', p_split_reason
    );
END;
$$;

-- D. qc_evaluate_work_item
CREATE OR REPLACE FUNCTION qc_evaluate_work_item(
    p_work_item_id UUID,
    p_passed BOOLEAN,
    p_remediation_stage TEXT DEFAULT NULL,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_item production_work_items%ROWTYPE;
    v_job production_jobs%ROWTYPE;
    v_rem_idx INT;
    v_is_terminal BOOLEAN;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required.';
    END IF;

    SELECT * INTO v_item FROM production_work_items WHERE id = p_work_item_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Work item % not found.', p_work_item_id;
    END IF;

    SELECT * INTO v_job FROM production_jobs WHERE id = v_item.job_id FOR SHARE;
    IF v_job.status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'Cannot evaluate QC: Parent job % is %.', v_job.id, v_job.status;
    END IF;

    IF NOT user_has_branch_access(v_job.branch_id) THEN
        RAISE EXCEPTION 'Access denied for production branch %.', v_job.branch_id;
    END IF;

    IF v_item.status NOT IN ('IN_PROGRESS', 'COMPLETED') THEN
        RAISE EXCEPTION 'Work item % in status % cannot be evaluated for QC.', p_work_item_id, v_item.status;
    END IF;

    IF p_passed THEN
        -- QC Pass: verify or advance to terminal PACKED
        v_is_terminal := (v_item.current_stage = 'PACKED');
        
        UPDATE production_work_items
        SET status = CASE WHEN v_is_terminal THEN 'COMPLETED'::work_item_status_enum ELSE status END,
            updated_at = NOW()
        WHERE id = p_work_item_id;

        INSERT INTO production_stage_logs (
            work_item_id,
            organization_id,
            from_stage,
            to_stage,
            transition_type,
            actor_id,
            notes,
            created_at
        ) VALUES (
            p_work_item_id,
            v_item.organization_id,
            v_item.current_stage,
            v_item.current_stage,
            'QC_PASS',
            v_user_id,
            COALESCE(p_notes, 'Pemeriksaan kualitas lolos (QC Pass)'),
            NOW()
        );

        RETURN jsonb_build_object(
            'success', true,
            'work_item_id', p_work_item_id,
            'passed', true,
            'status', CASE WHEN v_is_terminal THEN 'COMPLETED' ELSE 'IN_PROGRESS' END
        );
    ELSE
        -- QC Fail: must rewind to a valid service remediation stage
        IF p_remediation_stage IS NULL THEN
            RAISE EXCEPTION 'Remediation stage is mandatory when QC fails.';
        END IF;

        IF p_remediation_stage = 'PACKED' THEN
            RAISE EXCEPTION 'Invalid remediation stage: QC_FAIL cannot target terminal PACKED stage.';
        END IF;

        -- Find remediation stage index in item snapshot
        v_rem_idx := array_position(v_item.service_stages, p_remediation_stage);
        IF v_rem_idx IS NULL THEN
            RAISE EXCEPTION 'Stage % is not a valid remediation stage for this service.', p_remediation_stage;
        END IF;

        UPDATE production_work_items
        SET current_stage = p_remediation_stage,
            stage_index = v_rem_idx,
            status = 'IN_PROGRESS',
            updated_at = NOW()
        WHERE id = p_work_item_id;

        INSERT INTO production_stage_logs (
            work_item_id,
            organization_id,
            from_stage,
            to_stage,
            transition_type,
            actor_id,
            notes,
            created_at
        ) VALUES (
            p_work_item_id,
            v_item.organization_id,
            v_item.current_stage,
            p_remediation_stage,
            'QC_FAIL',
            v_user_id,
            COALESCE(p_notes, 'QC Gagal: dikembalikan ke tahapan ' || p_remediation_stage),
            NOW()
        );

        RETURN jsonb_build_object(
            'success', true,
            'work_item_id', p_work_item_id,
            'passed', false,
            'remediated_to_stage', p_remediation_stage
        );
    END IF;
END;
$$;

-- E. complete_production_job
CREATE OR REPLACE FUNCTION complete_production_job(
    p_job_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_job production_jobs%ROWTYPE;
    v_order orders%ROWTYPE;
    v_incomplete_count INT;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required.';
    END IF;

    SELECT * INTO v_job FROM production_jobs WHERE id = p_job_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Production job % not found.', p_job_id;
    END IF;

    SELECT * INTO v_order FROM orders WHERE id = v_job.order_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Order % not found.', v_job.order_id;
    END IF;

    IF v_job.status = 'COMPLETED' THEN
        RETURN jsonb_build_object(
            'success', true,
            'job_id', p_job_id,
            'status', 'COMPLETED',
            'is_local', (v_order.branch_id = v_order.production_branch_id),
            'order_status', CASE WHEN v_order.branch_id = v_order.production_branch_id THEN 'READY' ELSE 'WASHING' END,
            'message', 'Job is already completed.'
        );
    END IF;

    IF v_job.status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'Cannot complete job % with status %.', p_job_id, v_job.status;
    END IF;

    IF NOT user_has_branch_access(v_job.branch_id) THEN
        RAISE EXCEPTION 'Access denied for production branch %.', v_job.branch_id;
    END IF;

    -- Invariant: Every active leaf work item MUST be COMPLETED
    -- Active leaves = items that are NOT parents of split items
    SELECT COUNT(*) INTO v_incomplete_count
    FROM production_work_items pwi
    WHERE pwi.job_id = p_job_id
      AND pwi.status <> 'SPLIT'
      AND pwi.status <> 'COMPLETED';

    IF v_incomplete_count > 0 THEN
        RAISE EXCEPTION 'Cannot complete production job %: % active work item(s) are still in progress.',
            p_job_id, v_incomplete_count;
    END IF;

    -- Mark job completed
    UPDATE production_jobs
    SET status = 'COMPLETED',
        completed_at = NOW(),
        completed_by = v_user_id,
        updated_at = NOW()
    WHERE id = p_job_id;

    -- LOCAL vs CENTRAL Lifecycle Management for orders.status
    IF v_order.branch_id = v_order.production_branch_id THEN
        -- Local production: immediately becomes READY on retail pickup shelf
        UPDATE orders 
        SET status = 'READY', updated_at = NOW() 
        WHERE id = v_job.order_id;

        INSERT INTO order_status_history (
            order_id, from_status, to_status, changed_by, notes, created_at
        ) VALUES (
            v_job.order_id, v_order.status, 'READY', v_user_id, 'Produksi lokal selesai & siap diambil (granular completion)', NOW()
        );
    ELSE
        -- Central production: workshop completion leaves order at WASHING.
        -- Return transit dispatch + origin receipt will govern the eventual transition to READY.
        NULL;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'job_id', p_job_id,
        'order_id', v_job.order_id,
        'status', 'COMPLETED',
        'is_local', (v_order.branch_id = v_order.production_branch_id),
        'order_status', CASE WHEN v_order.branch_id = v_order.production_branch_id THEN 'READY' ELSE 'WASHING' END,
        'completed_at', NOW()
    );
END;
$$;

-- F. complete_simple_production_job
CREATE OR REPLACE FUNCTION complete_simple_production_job(
    p_order_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_order orders%ROWTYPE;
    v_start_res JSONB;
    v_job_id UUID;
    v_item RECORD;
    v_curr_idx INT;
    v_target_stage TEXT;
    v_is_last BOOLEAN;
    v_comp_res JSONB;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required.';
    END IF;

    SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Order % not found.', p_order_id;
    END IF;

    -- Start production job if not started yet (validates physical custody gate)
    v_start_res := start_production_job(p_order_id);
    v_job_id := (v_start_res->>'job_id')::uuid;

    -- Complete all active work items step-by-step through remaining stages until PACKED
    FOR v_item IN 
        SELECT id, stage_index, current_stage, service_stages 
        FROM production_work_items 
        WHERE job_id = v_job_id AND status = 'IN_PROGRESS'
    LOOP
        -- Advance each remaining stage sequentially
        FOR v_curr_idx IN (v_item.stage_index + 1) .. array_length(v_item.service_stages, 1) LOOP
            v_target_stage := v_item.service_stages[v_curr_idx];
            v_is_last := (v_curr_idx = array_length(v_item.service_stages, 1) AND v_target_stage = 'PACKED');

            UPDATE production_work_items
            SET current_stage = v_target_stage,
                stage_index = v_curr_idx,
                status = CASE WHEN v_is_last THEN 'COMPLETED'::work_item_status_enum ELSE 'IN_PROGRESS'::work_item_status_enum END,
                updated_at = NOW()
            WHERE id = v_item.id;

            INSERT INTO production_stage_logs (
                work_item_id,
                organization_id,
                from_stage,
                to_stage,
                transition_type,
                actor_id,
                notes,
                created_at
            ) VALUES (
                v_item.id,
                v_order.organization_id,
                v_item.service_stages[v_curr_idx - 1],
                v_target_stage,
                'ADVANCE',
                v_user_id,
                'Proses otomatis mode simpel ke tahapan ' || v_target_stage,
                NOW()
            );
        END LOOP;
    END LOOP;

    -- Complete job (executes complete_production_job with all checks and local READY projection)
    v_comp_res := complete_production_job(v_job_id);

    RETURN jsonb_build_object(
        'success', true,
        'order_id', p_order_id,
        'job_id', v_job_id,
        'is_local', (v_order.branch_id = v_order.production_branch_id),
        'order_status', (v_comp_res->>'order_status')
    );
END;
$$;

-- Grant execution on transactional RPCs to authenticated role
REVOKE EXECUTE ON FUNCTION start_production_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_production_job(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION advance_work_item_stage(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION advance_work_item_stage(UUID, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION split_work_item(UUID, NUMERIC[], split_reason_enum, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION split_work_item(UUID, NUMERIC[], split_reason_enum, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION qc_evaluate_work_item(UUID, BOOLEAN, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qc_evaluate_work_item(UUID, BOOLEAN, TEXT, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION complete_production_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_production_job(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION complete_simple_production_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_simple_production_job(UUID) TO authenticated;

