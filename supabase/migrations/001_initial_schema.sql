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
