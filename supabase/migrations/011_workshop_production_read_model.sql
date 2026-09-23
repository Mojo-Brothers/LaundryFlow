-- ============================================================================
-- 011_workshop_production_read_model.sql
-- LAUNDRYFLOW SAAS — WORKSHOP-WIDE PRODUCTION READ MODEL RPC
--
-- Boundary: UI -> Hook -> Application Service -> Production Repository -> SQL RPC
-- Preserves:
-- 1. Tenant Isolation: Derived strictly from auth_org_id() (no client override)
-- 2. Branch Security: Enforced via user_has_branch_access(p_workshop_branch_id)
-- 3. N+1 Elimination: Single-query bulk aggregation for all active workshop jobs
-- 4. Invariant Protection: SPLIT parents & CANCELLED items strictly excluded
-- 5. Zero PII Leakage: Only minimal customer display context (name) exposed
-- ============================================================================

CREATE OR REPLACE FUNCTION get_workshop_production(
    p_workshop_branch_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_org_id UUID;
    v_branch_name TEXT;
    v_result JSONB;
BEGIN
    -- 1. Authentication Prerequisite
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required.';
    END IF;

    -- 2. Tenant Context Derivation (Anti-Tamper: caller cannot override org)
    v_org_id := auth_org_id();
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Tenant organization context not found.';
    END IF;

    -- 3. Workshop Branch Authorization Gate
    IF NOT user_has_branch_access(p_workshop_branch_id) THEN
        RAISE EXCEPTION 'Access denied: User does not have access to workshop branch %.', p_workshop_branch_id;
    END IF;

    -- 4. Target Branch Tenant Validation
    SELECT name INTO v_branch_name
    FROM public.branches
    WHERE id = p_workshop_branch_id AND organization_id = v_org_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Branch % not found in current organization.', p_workshop_branch_id;
    END IF;

    -- 5. High-Performance Bulk Aggregation of Active Jobs & Leaf Work Items
    WITH active_jobs AS (
        SELECT 
            pj.id,
            pj.order_id,
            pj.branch_id,
            pj.rework_request_id,
            (pj.rework_request_id IS NOT NULL) AS is_rework,
            pj.status,
            pj.notes,
            pj.created_at,
            o.order_number,
            o.promised_ready_at,
            o.branch_id AS origin_branch_id,
            c.name AS customer_name
        FROM public.production_jobs pj
        JOIN public.orders o ON o.id = pj.order_id AND o.organization_id = v_org_id
        LEFT JOIN public.customers c ON c.id = o.customer_id AND c.organization_id = v_org_id
        WHERE pj.organization_id = v_org_id
          AND pj.branch_id = p_workshop_branch_id
          AND pj.status = 'IN_PROGRESS'
        ORDER BY pj.created_at ASC, pj.id ASC
    ),
    active_items AS (
        SELECT
            pwi.id,
            pwi.job_id,
            aj.order_id,
            aj.order_number,
            aj.customer_name,
            pwi.order_item_id,
            pwi.service_id,
            pwi.item_code,
            pwi.service_name_snap,
            pwi.unit,
            pwi.quantity,
            pwi.service_stages,
            pwi.current_stage,
            pwi.stage_index,
            pwi.status,
            pwi.parent_item_id,
            pwi.split_reason,
            pwi.notes,
            pwi.created_at,
            aj.status AS job_status,
            aj.rework_request_id,
            aj.is_rework,
            aj.created_at AS job_created_at,
            aj.branch_id AS workshop_branch_id,
            v_branch_name AS workshop_branch_name
        FROM public.production_work_items pwi
        JOIN active_jobs aj ON aj.id = pwi.job_id
        WHERE pwi.organization_id = v_org_id
          AND pwi.status <> 'SPLIT'
          AND pwi.status <> 'CANCELLED'
        ORDER BY pwi.created_at ASC, pwi.id ASC
    )
    SELECT jsonb_build_object(
        'workshop_branch_id', p_workshop_branch_id,
        'workshop_branch_name', v_branch_name,
        'jobs_count', COALESCE((SELECT COUNT(*) FROM active_jobs), 0),
        'work_items_count', COALESCE((SELECT COUNT(*) FROM active_items), 0),
        'jobs', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', aj.id,
                'order_id', aj.order_id,
                'order_number', aj.order_number,
                'customer_name', aj.customer_name,
                'branch_id', aj.branch_id,
                'rework_request_id', aj.rework_request_id,
                'is_rework', aj.is_rework,
                'status', aj.status,
                'created_at', aj.created_at,
                'work_items_count', (
                    SELECT COUNT(*) FROM active_items ai WHERE ai.job_id = aj.id
                )
            ) ORDER BY aj.created_at ASC, aj.id ASC)
            FROM active_jobs aj
        ), '[]'::jsonb),
        'work_items', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', ai.id,
                'job_id', ai.job_id,
                'order_id', ai.order_id,
                'order_number', ai.order_number,
                'customer_name', ai.customer_name,
                'order_item_id', ai.order_item_id,
                'service_id', ai.service_id,
                'item_code', ai.item_code,
                'service_name', ai.service_name_snap,
                'service_name_snap', ai.service_name_snap,
                'unit', ai.unit,
                'quantity', ai.quantity,
                'service_stages', ai.service_stages,
                'current_stage', ai.current_stage,
                'stage_index', ai.stage_index,
                'status', ai.status,
                'parent_item_id', ai.parent_item_id,
                'split_reason', ai.split_reason,
                'job_status', ai.job_status,
                'rework_request_id', ai.rework_request_id,
                'is_rework', ai.is_rework,
                'job_created_at', ai.job_created_at,
                'workshop_branch_id', ai.workshop_branch_id,
                'workshop_branch_name', ai.workshop_branch_name,
                'notes', ai.notes,
                'created_at', ai.created_at
            ) ORDER BY ai.created_at ASC, ai.id ASC)
            FROM active_items ai
        ), '[]'::jsonb)
    ) INTO v_result;

    RETURN v_result;
END;
$$;

-- Security Hardening: Revoke default public execution privileges
REVOKE EXECUTE ON FUNCTION get_workshop_production(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_workshop_production(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION get_workshop_production(UUID) TO authenticated;
