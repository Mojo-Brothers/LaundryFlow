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
