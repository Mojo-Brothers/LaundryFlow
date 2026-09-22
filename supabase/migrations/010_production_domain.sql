-- ============================================================================
-- 010_production_domain.sql
-- LAUNDRYFLOW SAAS — PRODUCTION DOMAIN SCHEMA, IMMUTABILITY & RPCS
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

