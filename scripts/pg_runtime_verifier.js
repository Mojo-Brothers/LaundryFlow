/**
 * ============================================================================
 * STEP 4B.3.4 — POSTGRESQL RUNTIME VERIFIER
 * Comprehensive runtime verification against Real PostgreSQL 16 engine
 * Covers Groups A through M (including dual-connection concurrency tests)
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
const { Client, Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_CONFIG = {
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '54332', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || undefined,
  database: process.env.PGDATABASE || 'laundryflow_test',
};

// Fixture Constants
const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const BRANCH_A1 = '11111111-aaaa-aaaa-aaaa-111111111111'; // OUTLET
const BRANCH_A2 = '11111111-aaaa-aaaa-aaaa-222222222222'; // OUTLET
const CENTRAL_A = '11111111-aaaa-aaaa-aaaa-333333333333'; // CENTRAL_PRODUCTION
const BRANCH_B1 = '11111111-bbbb-bbbb-bbbb-111111111111'; // OUTLET

const USER_A_OWNER = '22222222-aaaa-aaaa-aaaa-111111111111';
const USER_A_A1 = '22222222-aaaa-aaaa-aaaa-222222222222';
const USER_A_DRIVER = '22222222-aaaa-aaaa-aaaa-333333333333';
const USER_A_OPERATOR = '22222222-aaaa-aaaa-aaaa-444444444444';
const USER_A_VIEWER = '22222222-aaaa-aaaa-aaaa-555555555555';
const USER_B_USER = '22222222-bbbb-bbbb-bbbb-111111111111';

const SVC_A = '33333333-aaaa-aaaa-aaaa-111111111111';
const SVC_B = '33333333-bbbb-bbbb-bbbb-111111111111';

const CUST_A = '44444444-aaaa-aaaa-aaaa-111111111111';
const CUST_B = '44444444-bbbb-bbbb-bbbb-111111111111';

const results = [];

function record(item) {
  results.push(item);
  const mark = item.status === 'PASS' ? '✅ PASS' : '❌ FAIL';
  console.log(`[${item.id}] [${item.group}] ${item.scenario} -> ${mark}`);
  if (item.status === 'FAIL' || item.details) {
    console.log(`   Expected: ${item.expected}`);
    console.log(`   Actual:   ${item.actual}`);
    if (item.details) console.log(`   Details:  ${item.details}`);
  }
}

async function runTest() {
  const pool = new Pool(DB_CONFIG);
  const client = await pool.connect();

  console.log('================================================================');
  console.log('🚀 STARTING STEP 4B.3.4 POSTGRESQL RUNTIME VERIFICATION');
  console.log(`Connected to: PostgreSQL 16 at ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  console.log('================================================================\n');

  try {
    // ------------------------------------------------------------------------
    // APPLY MIGRATION 008 (DIRECTED TRANSIT ROUTING)
    // ------------------------------------------------------------------------
    console.log('Applying Migration 008 (Directed Transit Routing)...');
    const mig008Path = path.join(__dirname, '../supabase/migrations/008_directed_transit_routing.sql');
    const mig008Sql = fs.readFileSync(mig008Path, 'utf8');
    await client.query(mig008Sql);
    console.log('Migration 008 applied successfully.\n');

    // ------------------------------------------------------------------------
    // APPLY MIGRATION 009 (MULTI-CYCLE REWORK GATE)
    // ------------------------------------------------------------------------
    console.log('Applying Migration 009 (Multi-Cycle Rework Gate)...');
    const mig009Path = path.join(__dirname, '../supabase/migrations/009_multi_cycle_rework_gate.sql');
    const mig009Sql = fs.readFileSync(mig009Path, 'utf8');
    await client.query(mig009Sql);
    console.log('Migration 009 applied successfully.\n');

    // ------------------------------------------------------------------------
    // SETUP FIXTURES
    // ------------------------------------------------------------------------
    console.log('Seeding controlled test fixtures...');
    await client.query('BEGIN');

    // Clean previous fixture rows if any
    await client.query('ALTER TABLE transit_manifest_items DISABLE TRIGGER ALL');
    await client.query('ALTER TABLE transit_manifests DISABLE TRIGGER ALL');
    await client.query('DELETE FROM order_rework_requests WHERE organization_id IN ($1, $2)', [ORG_A, ORG_B]);
    await client.query('DELETE FROM transit_manifest_history WHERE organization_id IN ($1, $2)', [ORG_A, ORG_B]);
    await client.query('DELETE FROM transit_manifest_items WHERE organization_id IN ($1, $2)', [ORG_A, ORG_B]);
    await client.query('DELETE FROM transit_manifests WHERE organization_id IN ($1, $2)', [ORG_A, ORG_B]);
    await client.query('ALTER TABLE transit_manifest_items ENABLE TRIGGER ALL');
    await client.query('ALTER TABLE transit_manifests ENABLE TRIGGER ALL');
    await client.query('DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE organization_id IN ($1, $2))', [ORG_A, ORG_B]);
    await client.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE organization_id IN ($1, $2))', [ORG_A, ORG_B]);
    await client.query('DELETE FROM payments WHERE organization_id IN ($1, $2)', [ORG_A, ORG_B]);
    await client.query('DELETE FROM orders WHERE organization_id IN ($1, $2)', [ORG_A, ORG_B]);
    await client.query('DELETE FROM services WHERE organization_id IN ($1, $2)', [ORG_A, ORG_B]);
    await client.query('DELETE FROM customers WHERE organization_id IN ($1, $2)', [ORG_A, ORG_B]);
    await client.query('DELETE FROM user_branch_access WHERE user_id IN ($1, $2, $3, $4, $5, $6)', [USER_A_OWNER, USER_A_A1, USER_A_DRIVER, USER_A_OPERATOR, USER_A_VIEWER, USER_B_USER]);
    await client.query('DELETE FROM users WHERE id IN ($1, $2, $3, $4, $5, $6)', [USER_A_OWNER, USER_A_A1, USER_A_DRIVER, USER_A_OPERATOR, USER_A_VIEWER, USER_B_USER]);
    await client.query('DELETE FROM branches WHERE id IN ($1, $2, $3, $4)', [BRANCH_A1, BRANCH_A2, CENTRAL_A, BRANCH_B1]);
    await client.query('DELETE FROM organizations WHERE id IN ($1, $2)', [ORG_A, ORG_B]);

    // Insert Organizations
    await client.query(`
      INSERT INTO organizations (id, name, slug) VALUES 
      ($1, 'Organization A', 'org-a'),
      ($2, 'Organization B', 'org-b')
    `, [ORG_A, ORG_B]);

    // Insert Branches
    await client.query(`
      INSERT INTO branches (id, organization_id, code, name, branch_type) VALUES
      ($1, $2, 'A1', 'Branch A1 Outlet', 'OUTLET'),
      ($3, $2, 'A2', 'Branch A2 Outlet', 'OUTLET'),
      ($4, $2, 'CP-A', 'Central Production A', 'CENTRAL_PRODUCTION'),
      ($5, $6, 'B1', 'Branch B1 Outlet', 'OUTLET')
    `, [BRANCH_A1, ORG_A, BRANCH_A2, CENTRAL_A, BRANCH_B1, ORG_B]);

    // Insert Users
    await client.query(`
      INSERT INTO users (id, organization_id, email, full_name, role, default_branch_id) VALUES
      ($1, $2, 'owner@a.id', 'Owner A', 'OWNER', $3),
      ($4, $2, 'cashier@a.id', 'Cashier A1', 'CASHIER', $3),
      ($5, $2, 'driver@a.id', 'Driver A', 'DRIVER', $3),
      ($6, $2, 'operator@a.id', 'Operator A', 'OPERATOR', $7),
      ($8, $2, 'viewer@a.id', 'Viewer A', 'VIEWER', $3),
      ($9, $10, 'user@b.id', 'User B1', 'CASHIER', $11)
    `, [USER_A_OWNER, ORG_A, BRANCH_A1, USER_A_A1, USER_A_DRIVER, USER_A_OPERATOR, CENTRAL_A, USER_A_VIEWER, USER_B_USER, ORG_B, BRANCH_B1]);

    // Insert Branch Access
    await client.query(`
      INSERT INTO user_branch_access (user_id, branch_id) VALUES
      ($1, $2), ($1, $3), ($1, $4),
      ($5, $2),
      ($6, $2), ($6, $4),
      ($7, $4),
      ($8, $9)
    `, [USER_A_OWNER, BRANCH_A1, BRANCH_A2, CENTRAL_A, USER_A_A1, USER_A_DRIVER, USER_A_OPERATOR, USER_B_USER, BRANCH_B1]);

    // Insert Services & Customers
    await client.query(`
      INSERT INTO services (id, organization_id, name, category, unit, base_price) VALUES
      ($1, $2, 'Cuci Reguler A', 'Kiloan', 'KG', 10000),
      ($3, $4, 'Cuci Reguler B', 'Kiloan', 'KG', 12000)
    `, [SVC_A, ORG_A, SVC_B, ORG_B]);

    await client.query(`
      INSERT INTO customers (id, organization_id, name, phone) VALUES
      ($1, $2, 'Customer A', '081111111111'),
      ($3, $4, 'Customer B', '082222222222')
    `, [CUST_A, ORG_A, CUST_B, ORG_B]);

    await client.query('COMMIT');
    console.log('Fixtures seeded successfully.\n');

    // Helper: Create Order in DB
    const createDbOrder = async (orderId, orgId, branchId, prodBranchId, orderNum, status = 'RECEIVED') => {
      const token = 'trk_' + orderNum.toLowerCase() + '_' + Math.random().toString(36).slice(2, 6);
      await client.query(`
        INSERT INTO orders (id, organization_id, branch_id, production_branch_id, customer_id, order_number, tracking_token, status, operating_mode, subtotal, final_amount, paid_amount, payment_status, promised_ready_at, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SIMPLE', 20000, 20000, 20000, 'PAID', NOW() + INTERVAL '24 hours', $9)
      `, [orderId, orgId, branchId, prodBranchId, orgId === ORG_A ? CUST_A : CUST_B, orderNum, token, status, orgId === ORG_A ? USER_A_A1 : USER_B_USER]);
    };

    // Helper: Create Manifest in DB
    const createDbManifest = async (manId, orgId, srcBranch, dstBranch, manNum, status = 'DRAFT', driverId = null) => {
      await client.query(`
        INSERT INTO transit_manifests (id, organization_id, manifest_number, source_branch_id, destination_branch_id, driver_user_id, status, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [manId, orgId, manNum, srcBranch, dstBranch, driverId, status, orgId === ORG_A ? USER_A_A1 : USER_B_USER]);
    };

    // Helper: Create Manifest with attached items through valid lifecycle
    const createManifestWithItems = async (manId, orgId, srcBranch, dstBranch, manNum, itemOrderIds, targetStatus = 'DRAFT', driverId = null) => {
      await createDbManifest(manId, orgId, srcBranch, dstBranch, manNum, 'DRAFT', driverId);
      for (const ordId of itemOrderIds) {
        await client.query(`
          INSERT INTO transit_manifest_items (manifest_id, organization_id, order_id, received_status)
          VALUES ($1, $2, $3, 'EXPECTED')
        `, [manId, orgId, ordId]);
      }
      if (targetStatus === 'READY_TO_DISPATCH' || targetStatus === 'IN_TRANSIT' || targetStatus === 'RECEIVED') {
        await client.query("UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1", [manId]);
      }
      if (targetStatus === 'IN_TRANSIT' || targetStatus === 'RECEIVED') {
        await client.query("UPDATE transit_manifests SET status = 'IN_TRANSIT' WHERE id = $1", [manId]);
      }
      if (targetStatus === 'RECEIVED') {
        await client.query("UPDATE transit_manifests SET status = 'RECEIVED' WHERE id = $1", [manId]);
      }
    };

    // ========================================================================
    // TEST GROUP A — CROSS-BRANCH & CROSS-TENANT INTEGRITY
    // ========================================================================
    console.log('--- Executing Test Group A (Cross-Branch & Cross-Tenant) ---');
    const orderA1_1 = '55555555-aaaa-1111-0001-000000000001';
    const orderA2_1 = '55555555-aaaa-2222-0001-000000000001';
    const orderB1_1 = '55555555-bbbb-1111-0001-000000000001';
    await createDbOrder(orderA1_1, ORG_A, BRANCH_A1, CENTRAL_A, 'ORD-A1-001');
    await createDbOrder(orderA2_1, ORG_A, BRANCH_A2, CENTRAL_A, 'ORD-A2-001');
    await createDbOrder(orderB1_1, ORG_B, BRANCH_B1, BRANCH_B1, 'ORD-B1-001');

    const manA_A1 = '66666666-aaaa-1111-0001-000000000001';
    await createDbManifest(manA_A1, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-A1-001');

    // A1: Same branch attach
    try {
      await client.query(`
        INSERT INTO transit_manifest_items (manifest_id, organization_id, order_id, received_status)
        VALUES ($1, $2, $3, 'EXPECTED')
      `, [manA_A1, ORG_A, orderA1_1]);
      record({
        id: 'PG-A1',
        group: 'Group A: Cross-Branch',
        scenario: 'Same-branch order attachment (Org A, Branch A1 -> Manifest A1)',
        connections: 1,
        operation: 'INSERT INTO transit_manifest_items',
        expected: 'ACCEPT (item inserted, total_expected_orders incremented)',
        actual: 'ACCEPTED',
        status: 'PASS',
      });
    } catch (err) {
      record({
        id: 'PG-A1',
        group: 'Group A: Cross-Branch',
        scenario: 'Same-branch order attachment',
        connections: 1,
        operation: 'INSERT',
        expected: 'ACCEPT',
        actual: 'REJECTED: ' + err.message,
        status: 'FAIL',
      });
    }

    // A2: Cross branch attach (Org A, Branch A2 order -> Manifest A1)
    try {
      await client.query(`
        INSERT INTO transit_manifest_items (manifest_id, organization_id, order_id, received_status)
        VALUES ($1, $2, $3, 'EXPECTED')
      `, [manA_A1, ORG_A, orderA2_1]);
      record({
        id: 'PG-A2',
        group: 'Group A: Cross-Branch',
        scenario: 'Cross-branch order attachment (Order A2 -> Manifest A1)',
        connections: 1,
        operation: 'INSERT INTO transit_manifest_items',
        expected: 'REJECT (Cross-branch violation)',
        actual: 'ACCEPTED (Vulnerability!)',
        status: 'FAIL',
      });
    } catch (err) {
      const isCrossBranch = err.message.includes('Cross-branch violation');
      record({
        id: 'PG-A2',
        group: 'Group A: Cross-Branch',
        scenario: 'Cross-branch order attachment (Order A2 -> Manifest A1)',
        connections: 1,
        operation: 'INSERT INTO transit_manifest_items',
        expected: 'REJECT with Cross-branch violation',
        actual: `REJECTED: ${err.message}`,
        status: isCrossBranch ? 'PASS' : 'FAIL',
      });
    }

    // A3: Cross tenant attach (Org B Order -> Manifest A1)
    try {
      await client.query(`
        INSERT INTO transit_manifest_items (manifest_id, organization_id, order_id, received_status)
        VALUES ($1, $2, $3, 'EXPECTED')
      `, [manA_A1, ORG_A, orderB1_1]);
      record({
        id: 'PG-A3',
        group: 'Group A: Cross-Branch',
        scenario: 'Cross-tenant order attachment (Org B order -> Manifest A1)',
        connections: 1,
        operation: 'INSERT INTO transit_manifest_items',
        expected: 'REJECT with Cross-tenant or FK violation',
        actual: 'ACCEPTED (Vulnerability!)',
        status: 'FAIL',
      });
    } catch (err) {
      const isTenantOrFk = err.message.includes('Cross-tenant') || err.message.includes('foreign key') || err.message.includes('violates foreign key');
      record({
        id: 'PG-A3',
        group: 'Group A: Cross-Branch',
        scenario: 'Cross-tenant order attachment (Org B order -> Manifest A1)',
        connections: 1,
        operation: 'INSERT INTO transit_manifest_items',
        expected: 'REJECT with Cross-tenant or FK violation',
        actual: `REJECTED: ${err.message}`,
        status: isTenantOrFk ? 'PASS' : 'FAIL',
      });
    }

    // ========================================================================
    // TEST GROUP B — PARENT ROUTE INTEGRITY
    // ========================================================================
    console.log('--- Executing Test Group B (Parent Route Integrity) ---');
    const emptyManB = '66666666-aaaa-2222-0001-000000000001';
    await createDbManifest(emptyManB, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-A1-EMPTY');

    // B1: Empty DRAFT route change
    try {
      await client.query(`
        UPDATE transit_manifests 
        SET source_branch_id = $1 
        WHERE id = $2
      `, [BRANCH_A2, emptyManB]);
      const res = await client.query('SELECT source_branch_id FROM transit_manifests WHERE id = $1', [emptyManB]);
      const ok = res.rows[0].source_branch_id === BRANCH_A2;
      record({
        id: 'PG-B1',
        group: 'Group B: Parent Route',
        scenario: 'Empty DRAFT manifest route change (source A1 -> A2)',
        connections: 1,
        operation: 'UPDATE transit_manifests SET source_branch_id = A2',
        expected: 'ACCEPT (Source branch updated to A2)',
        actual: ok ? 'ACCEPTED (source_branch_id = A2)' : 'FAIL',
        status: ok ? 'PASS' : 'FAIL',
      });
    } catch (err) {
      record({
        id: 'PG-B1',
        group: 'Group B: Parent Route',
        scenario: 'Empty DRAFT manifest route change',
        connections: 1,
        operation: 'UPDATE',
        expected: 'ACCEPT',
        actual: 'REJECTED: ' + err.message,
        status: 'FAIL',
      });
    }

    // B2: DRAFT with items route change (manA_A1 has orderA1_1 attached)
    try {
      await client.query(`
        UPDATE transit_manifests 
        SET source_branch_id = $1 
        WHERE id = $2
      `, [BRANCH_A2, manA_A1]);
      record({
        id: 'PG-B2',
        group: 'Group B: Parent Route',
        scenario: 'DRAFT with items route change (source A1 -> A2)',
        connections: 1,
        operation: 'UPDATE transit_manifests SET source_branch_id = A2',
        expected: 'REJECT (Cannot modify source_branch_id while items are attached)',
        actual: 'ACCEPTED (Vulnerability!)',
        status: 'FAIL',
      });
    } catch (err) {
      const isRouteLocked = err.message.includes('while items are attached');
      const checkRes = await client.query('SELECT source_branch_id FROM transit_manifests WHERE id = $1', [manA_A1]);
      const remainedA1 = checkRes.rows[0].source_branch_id === BRANCH_A1;
      record({
        id: 'PG-B2',
        group: 'Group B: Parent Route',
        scenario: 'DRAFT with items route change (source A1 -> A2)',
        connections: 1,
        operation: 'UPDATE transit_manifests SET source_branch_id = A2',
        expected: 'REJECT with items attached error',
        actual: `REJECTED: ${err.message}`,
        status: isRouteLocked && remainedA1 ? 'PASS' : 'FAIL',
      });
    }

    // B3: READY / IN_TRANSIT route mutation
    const inTransitMan = '66666666-aaaa-3333-0001-000000000001';
    await createDbManifest(inTransitMan, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-A1-TRANSIT', 'IN_TRANSIT', USER_A_DRIVER);
    try {
      await client.query(`
        UPDATE transit_manifests SET source_branch_id = $1 WHERE id = $2
      `, [BRANCH_A2, inTransitMan]);
      record({
        id: 'PG-B3',
        group: 'Group B: Parent Route',
        scenario: 'IN_TRANSIT route mutation',
        connections: 1,
        operation: 'UPDATE transit_manifests SET source_branch_id = A2',
        expected: 'REJECT (while IN_TRANSIT)',
        actual: 'ACCEPTED (Vulnerability!)',
        status: 'FAIL',
      });
    } catch (err) {
      const pass = err.message.includes('while IN_TRANSIT');
      record({
        id: 'PG-B3',
        group: 'Group B: Parent Route',
        scenario: 'IN_TRANSIT route mutation',
        connections: 1,
        operation: 'UPDATE transit_manifests SET source_branch_id',
        expected: 'REJECT (Cannot alter source or destination branch while IN_TRANSIT)',
        actual: `REJECTED: ${err.message}`,
        status: pass ? 'PASS' : 'FAIL',
      });
    }

    // B4: RECEIVED route mutation
    const receivedMan = '66666666-aaaa-4444-0001-000000000001';
    await createDbManifest(receivedMan, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-A1-RECV', 'RECEIVED', USER_A_DRIVER);
    try {
      await client.query(`UPDATE transit_manifests SET source_branch_id = $1 WHERE id = $2`, [BRANCH_A2, receivedMan]);
      record({
        id: 'PG-B4',
        group: 'Group B: Parent Route',
        scenario: 'RECEIVED route mutation',
        connections: 1,
        operation: 'UPDATE transit_manifests',
        expected: 'REJECT (strictly immutable)',
        actual: 'ACCEPTED (Vulnerability!)',
        status: 'FAIL',
      });
    } catch (err) {
      const pass = err.message.includes('already RECEIVED and is strictly immutable');
      record({
        id: 'PG-B4',
        group: 'Group B: Parent Route',
        scenario: 'RECEIVED route mutation',
        connections: 1,
        operation: 'UPDATE transit_manifests SET source_branch_id',
        expected: 'REJECT (strictly immutable)',
        actual: `REJECTED: ${err.message}`,
        status: pass ? 'PASS' : 'FAIL',
      });
    }

    // ========================================================================
    // TEST GROUP C — TERMINAL IMMUTABILITY
    // ========================================================================
    console.log('--- Executing Test Group C (Terminal Immutability) ---');
    const termMan = '66666666-aaaa-4444-0001-000000000002';
    const termOrder = '55555555-aaaa-1111-0002-000000000001';
    await createDbOrder(termOrder, ORG_A, BRANCH_A1, CENTRAL_A, 'ORD-A1-TERM');
    await createManifestWithItems(termMan, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-A1-TERM', [termOrder], 'RECEIVED', USER_A_DRIVER);

    const fieldsToTest = [
      { col: 'driver_user_id', val: USER_A_OPERATOR },
      { col: 'vehicle_identifier', val: 'B 9999 HACK' },
      { col: 'notes', val: 'Hacked notes' },
      { col: 'status', val: 'DRAFT' },
      { col: 'destination_branch_id', val: BRANCH_A2 },
    ];

    let allManifestFieldsRejected = true;
    for (const f of fieldsToTest) {
      try {
        await client.query(`UPDATE transit_manifests SET ${f.col} = $1 WHERE id = $2`, [f.val, termMan]);
        allManifestFieldsRejected = false;
      } catch (err) {
        // Expected reject
      }
    }

    record({
      id: 'PG-C1',
      group: 'Group C: Terminal Immutability',
      scenario: 'RECEIVED manifest: mutate driver, vehicle, notes, status, destination',
      connections: 1,
      operation: 'UPDATE transit_manifests SET <field>',
      expected: 'ALL REJECT (strictly immutable)',
      actual: allManifestFieldsRejected ? 'ALL REJECTED' : 'ONE OR MORE MUTATIONS ACCEPTED',
      status: allManifestFieldsRejected ? 'PASS' : 'FAIL',
    });

    // Item fields test on RECEIVED manifest
    const itemFields = [
      { col: 'received_status', val: 'DAMAGED' },
      { col: 'discrepancy_notes', val: 'Malicious note' },
    ];
    let allItemFieldsRejected = true;
    for (const f of itemFields) {
      try {
        await client.query(`UPDATE transit_manifest_items SET ${f.col} = $1 WHERE manifest_id = $2 AND order_id = $3`, [f.val, termMan, termOrder]);
        allItemFieldsRejected = false;
      } catch (err) {
        // Expected reject
      }
    }
    record({
      id: 'PG-C2',
      group: 'Group C: Terminal Immutability',
      scenario: 'RECEIVED parent item: mutate received_status and discrepancy_notes',
      connections: 1,
      operation: 'UPDATE transit_manifest_items SET <field>',
      expected: 'ALL REJECT (strictly immutable)',
      actual: allItemFieldsRejected ? 'ALL REJECTED' : 'ONE OR MORE MUTATIONS ACCEPTED',
      status: allItemFieldsRejected ? 'PASS' : 'FAIL',
    });

    // Item INSERT & DELETE on RECEIVED manifest
    let insertRejected = false;
    const newTermOrder = '55555555-aaaa-1111-0003-000000000001';
    await createDbOrder(newTermOrder, ORG_A, BRANCH_A1, CENTRAL_A, 'ORD-A1-NEWTERM');
    try {
      await client.query(`
        INSERT INTO transit_manifest_items (manifest_id, organization_id, order_id, received_status)
        VALUES ($1, $2, $3, 'EXPECTED')
      `, [termMan, ORG_A, newTermOrder]);
    } catch (err) {
      insertRejected = err.message.includes('Cannot attach order to manifest') || err.message.includes('strictly immutable');
    }

    let deleteRejected = false;
    try {
      await client.query(`DELETE FROM transit_manifest_items WHERE manifest_id = $1 AND order_id = $2`, [termMan, termOrder]);
    } catch (err) {
      deleteRejected = err.message.includes('Items can only be removed while in DRAFT') || err.message.includes('strictly immutable');
    }

    record({
      id: 'PG-C3',
      group: 'Group C: Terminal Immutability',
      scenario: 'RECEIVED parent item: direct INSERT and DELETE',
      connections: 1,
      operation: 'INSERT & DELETE transit_manifest_items',
      expected: 'BOTH REJECT',
      actual: insertRejected && deleteRejected ? 'BOTH REJECTED' : `INSERT rejected: ${insertRejected}, DELETE rejected: ${deleteRejected}`,
      status: insertRejected && deleteRejected ? 'PASS' : 'FAIL',
    });

    // C4: CANCELLED manifest immutability
    const canMan = '66666666-aaaa-4444-0001-000000000003';
    await createDbManifest(canMan, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-A1-CANTERM', 'CANCELLED');
    let canMutateRejected = true;
    for (const f of fieldsToTest) {
      try {
        await client.query(`UPDATE transit_manifests SET ${f.col} = $1 WHERE id = $2`, [f.val, canMan]);
        canMutateRejected = false;
      } catch (err) {
        // Expected reject
      }
    }
    record({
      id: 'PG-C4',
      group: 'Group C: Terminal Immutability',
      scenario: 'CANCELLED manifest: mutate driver, vehicle, notes, status, destination',
      connections: 1,
      operation: 'UPDATE transit_manifests SET <field>',
      expected: 'ALL REJECT (strictly immutable)',
      actual: canMutateRejected ? 'ALL REJECTED' : 'ONE OR MORE MUTATIONS ACCEPTED',
      status: canMutateRejected ? 'PASS' : 'FAIL',
    });

    // ========================================================================
    // TEST GROUP D — DELETE INVARIANT
    // ========================================================================
    console.log('--- Executing Test Group D (Delete Invariant) ---');
    const statusesToTestDelete = [
      { status: 'RECEIVED', id: receivedMan },
      { status: 'CANCELLED', id: '66666666-aaaa-5555-0001-000000000001' },
      { status: 'IN_TRANSIT', id: inTransitMan },
      { status: 'READY_TO_DISPATCH', id: '66666666-aaaa-6666-0001-000000000001' },
      { status: 'DRAFT', id: emptyManB },
    ];

    // Seed missing test manifests
    await createDbManifest('66666666-aaaa-5555-0001-000000000001', ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-A1-CAN', 'CANCELLED');
    await createDbManifest('66666666-aaaa-6666-0001-000000000001', ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-A1-READY', 'READY_TO_DISPATCH', USER_A_DRIVER);

    let allDeletesRejected = true;
    for (const item of statusesToTestDelete) {
      try {
        await client.query('DELETE FROM transit_manifests WHERE id = $1', [item.id]);
        allDeletesRejected = false;
        console.log(`Failed to reject delete on status ${item.status}!`);
      } catch (err) {
        // Expected reject
      }
    }

    // Verify records remained intact
    const remainingCount = await client.query('SELECT COUNT(*) FROM transit_manifests WHERE id IN ($1, $2, $3, $4, $5)', statusesToTestDelete.map(s => s.id));

    record({
      id: 'PG-D1',
      group: 'Group D: Delete Invariant',
      scenario: 'DELETE transit_manifests across all statuses (RECEIVED, CANCELLED, IN_TRANSIT, READY, DRAFT)',
      connections: 1,
      operation: 'DELETE FROM transit_manifests WHERE id = ...',
      expected: 'ALL REJECT (All 5 manifests and history preserved)',
      actual: allDeletesRejected && Number(remainingCount.rows[0].count) === 5 ? 'ALL REJECTED, 5/5 MANIFESTS PRESERVED' : 'FAIL',
      status: allDeletesRejected && Number(remainingCount.rows[0].count) === 5 ? 'PASS' : 'FAIL',
    });

    // ========================================================================
    // TEST GROUP E — RECEIVING ATOMICITY & ROLLBACK
    // ========================================================================
    console.log('--- Executing Test Group E (Receiving Atomicity & Rollback) ---');
    const recvManId = '66666666-aaaa-7777-0001-000000000001';
    const o1 = '55555555-aaaa-7777-0001-000000000001';
    const o2 = '55555555-aaaa-7777-0001-000000000002';
    const o3 = '55555555-aaaa-7777-0001-000000000003';
    await createDbOrder(o1, ORG_A, BRANCH_A1, CENTRAL_A, 'ORD-E-01');
    await createDbOrder(o2, ORG_A, BRANCH_A1, CENTRAL_A, 'ORD-E-02');
    await createDbOrder(o3, ORG_A, BRANCH_A1, CENTRAL_A, 'ORD-E-03');

    await createManifestWithItems(recvManId, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-E-ATOMIC', [o1, o2, o3], 'IN_TRANSIT', USER_A_DRIVER);

    // Valid receiving via RPC
    // Set authenticated context for Central A operator
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [USER_A_OPERATOR]);
    const itemsReviewJson = JSON.stringify([
      { order_id: o1, status: 'RECEIVED_OK', notes: null },
      { order_id: o2, status: 'RECEIVED_OK', notes: null },
      { order_id: o3, status: 'DAMAGED', notes: 'Sobek kemasan' },
    ]);

    await client.query(`
      SELECT receive_manifest_with_discrepancy($1, $2::jsonb, $3)
    `, [recvManId, itemsReviewJson, 'Inspeksi kedatangan komplit']);

    const manRecvCheck = await client.query('SELECT status, total_received_orders, has_discrepancy FROM transit_manifests WHERE id = $1', [recvManId]);
    const itemsRecvCheck = await client.query('SELECT received_status, discrepancy_notes FROM transit_manifest_items WHERE manifest_id = $1 AND order_id = $2', [recvManId, o3]);

    const recvSuccess = manRecvCheck.rows[0].status === 'RECEIVED' &&
      manRecvCheck.rows[0].total_received_orders === 2 &&
      manRecvCheck.rows[0].has_discrepancy === true &&
      itemsRecvCheck.rows[0].received_status === 'DAMAGED';

    record({
      id: 'PG-E1',
      group: 'Group E: Receiving Atomicity',
      scenario: 'Atomic receiving with item discrepancies (2 RECEIVED_OK, 1 DAMAGED)',
      connections: 1,
      operation: 'receive_manifest_with_discrepancy RPC',
      expected: 'Status RECEIVED, 2 received orders, has_discrepancy = true',
      actual: recvSuccess ? 'RECEIVED with discrepancy persisted' : 'FAIL',
      status: recvSuccess ? 'PASS' : 'FAIL',
    });

    // Forced Failure Injection & Rollback
    const rollbackManId = '66666666-aaaa-8888-0001-000000000001';
    const oRoll = '55555555-aaaa-8888-0001-000000000001';
    await createDbOrder(oRoll, ORG_A, BRANCH_A1, CENTRAL_A, 'ORD-E-ROLL');
    await createManifestWithItems(rollbackManId, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-E-ROLL', [oRoll], 'IN_TRANSIT', USER_A_DRIVER);

    let rollbackClean = false;
    try {
      await client.query('BEGIN');
      // Pass invalid status to force PostgreSQL enum cast exception inside transaction
      await client.query(`SELECT receive_manifest_with_discrepancy($1, $2::jsonb, $3)`, [
        rollbackManId,
        JSON.stringify([{ order_id: oRoll, status: 'INVALID_ENUM_CRASH' }]),
        'Test crash'
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      const manRollCheck = await client.query('SELECT status FROM transit_manifests WHERE id = $1', [rollbackManId]);
      const itemRollCheck = await client.query('SELECT received_status FROM transit_manifest_items WHERE manifest_id = $1', [rollbackManId]);
      rollbackClean = manRollCheck.rows[0].status === 'IN_TRANSIT' && itemRollCheck.rows[0].received_status === 'EXPECTED';
    }

    record({
      id: 'PG-E2',
      group: 'Group E: Receiving Atomicity',
      scenario: 'Failure injection inside receiving transaction rolls back entire state',
      connections: 1,
      operation: 'receive_manifest_with_discrepancy with invalid enum -> ROLLBACK',
      expected: 'Full rollback, manifest remains IN_TRANSIT, item remains EXPECTED',
      actual: rollbackClean ? 'FULL ROLLBACK (0 partial mutation)' : 'DIRTY PARTIAL STATE',
      status: rollbackClean ? 'PASS' : 'FAIL',
    });

    // ========================================================================
    // TEST GROUP F — OMITTED ITEM SEMANTICS
    // ========================================================================
    console.log('--- Executing Test Group F (Omitted Item Semantics) ---');
    const omitManId = '66666666-aaaa-9999-0001-000000000001';
    const fA = '55555555-aaaa-9999-0001-000000000001';
    const fB = '55555555-aaaa-9999-0001-000000000002';
    const fC = '55555555-aaaa-9999-0001-000000000003';
    await createDbOrder(fA, ORG_A, BRANCH_A1, CENTRAL_A, 'ORD-F-A');
    await createDbOrder(fB, ORG_A, BRANCH_A1, CENTRAL_A, 'ORD-F-B');
    await createDbOrder(fC, ORG_A, BRANCH_A1, CENTRAL_A, 'ORD-F-C');

    await createManifestWithItems(omitManId, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-F-OMIT', [fA, fB, fC], 'IN_TRANSIT', USER_A_DRIVER);

    // Review only fA and fB. Omit fC.
    await client.query(`
      SELECT receive_manifest_with_discrepancy($1, $2::jsonb, $3)
    `, [omitManId, JSON.stringify([
      { order_id: fA, status: 'RECEIVED_OK', notes: null },
      { order_id: fB, status: 'RECEIVED_OK', notes: null },
    ]), 'Review parsial']);

    const omitCheck = await client.query('SELECT status, has_discrepancy FROM transit_manifests WHERE id = $1', [omitManId]);
    const fCStatus = await client.query('SELECT received_status, discrepancy_notes FROM transit_manifest_items WHERE manifest_id = $1 AND order_id = $2', [omitManId, fC]);

    const omitSuccess = omitCheck.rows[0].status === 'RECEIVED' &&
      omitCheck.rows[0].has_discrepancy === true &&
      fCStatus.rows[0].received_status === 'MISSING';

    record({
      id: 'PG-F1',
      group: 'Group F: Omitted Items',
      scenario: 'Items A & B reviewed as OK; Item C omitted from review payload',
      connections: 1,
      operation: 'receive_manifest_with_discrepancy',
      expected: 'Item C automatically becomes MISSING; has_discrepancy = true',
      actual: omitSuccess ? 'Item C set to MISSING, discrepancy flagged' : 'FAIL',
      status: omitSuccess ? 'PASS' : 'FAIL',
    });

    // ========================================================================
    // TEST GROUP G — STATE MACHINE TRANSITIONS
    // ========================================================================
    console.log('--- Executing Test Group G (State Machine Transitions) ---');
    const smManId = '66666666-aaaa-aaaa-0001-000000000001';
    await createDbManifest(smManId, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-G-SM', 'DRAFT');

    // DRAFT -> READY_TO_DISPATCH (Legal)
    await client.query("UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1", [smManId]);
    // READY_TO_DISPATCH -> DRAFT (Legal reversal)
    await client.query("UPDATE transit_manifests SET status = 'DRAFT' WHERE id = $1", [smManId]);
    // DRAFT -> READY_TO_DISPATCH
    await client.query("UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1", [smManId]);
    // READY_TO_DISPATCH -> IN_TRANSIT (Legal)
    await client.query("UPDATE transit_manifests SET status = 'IN_TRANSIT' WHERE id = $1", [smManId]);
    // IN_TRANSIT -> RECEIVED (Legal)
    await client.query("UPDATE transit_manifests SET status = 'RECEIVED' WHERE id = $1", [smManId]);

    let illegalTransitionBlocked = true;
    try {
      // RECEIVED -> DRAFT (Illegal reversal)
      await client.query("UPDATE transit_manifests SET status = 'DRAFT' WHERE id = $1", [smManId]);
      illegalTransitionBlocked = false;
    } catch (err) {
      // Expected
    }

    try {
      // Create new cancelled manifest
      const canManId = '66666666-aaaa-aaaa-0002-000000000001';
      await createDbManifest(canManId, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-G-CAN', 'CANCELLED');
      // CANCELLED -> DRAFT (Illegal)
      await client.query("UPDATE transit_manifests SET status = 'DRAFT' WHERE id = $1", [canManId]);
      illegalTransitionBlocked = false;
    } catch (err) {
      // Expected
    }

    record({
      id: 'PG-G1',
      group: 'Group G: State Machine',
      scenario: 'Verify legal forward/backward transitions and reject illegal transitions',
      connections: 1,
      operation: 'UPDATE transit_manifests SET status',
      expected: 'Legal transitions succeed; illegal reversals strictly rejected',
      actual: illegalTransitionBlocked ? 'LEGAL ACCEPTED, ILLEGAL REJECTED' : 'FAIL',
      status: illegalTransitionBlocked ? 'PASS' : 'FAIL',
    });

    // ========================================================================
    // TEST GROUP H — DOUBLE DISPATCH CONCURRENCY (DUAL REAL POSTGRESQL CONNECTIONS)
    // ========================================================================
    console.log('--- Executing Test Group H (Double Dispatch Concurrency) ---');
    const orderH = '55555555-aaaa-baaa-0001-000000000001';
    await createDbOrder(orderH, ORG_A, BRANCH_A1, CENTRAL_A, 'ORD-H-CONC');

    const manH1 = '66666666-aaaa-baaa-0001-000000000001';
    const manH2 = '66666666-aaaa-baaa-0002-000000000001';
    await createDbManifest(manH1, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-H-01');
    await createDbManifest(manH2, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-H-02');

    const conn1 = await pool.connect();
    const conn2 = await pool.connect();

    let conn1Success = false;
    let conn2Success = false;
    let conn1Err = '';
    let conn2Err = '';

    // Execute concurrently using independent PostgreSQL connections
    await Promise.all([
      (async () => {
        try {
          await conn1.query('BEGIN');
          await conn1.query(`
            INSERT INTO transit_manifest_items (manifest_id, organization_id, order_id, received_status)
            VALUES ($1, $2, $3, 'EXPECTED')
          `, [manH1, ORG_A, orderH]);
          // Artificial micro-delay inside transaction to test lock contention
          await new Promise(r => setTimeout(r, 40));
          await conn1.query('COMMIT');
          conn1Success = true;
        } catch (err) {
          await conn1.query('ROLLBACK');
          conn1Err = err.message;
        }
      })(),
      (async () => {
        try {
          await conn2.query('BEGIN');
          await conn2.query(`
            INSERT INTO transit_manifest_items (manifest_id, organization_id, order_id, received_status)
            VALUES ($1, $2, $3, 'EXPECTED')
          `, [manH2, ORG_A, orderH]);
          await conn2.query('COMMIT');
          conn2Success = true;
        } catch (err) {
          await conn2.query('ROLLBACK');
          conn2Err = err.message;
        }
      })(),
    ]);

    conn1.release();
    conn2.release();

    const activeAssignments = await client.query(`
      SELECT count(*) FROM transit_manifest_items tmi
      JOIN transit_manifests tm ON tm.id = tmi.manifest_id
      WHERE tmi.order_id = $1 AND tm.status IN ('DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT')
    `, [orderH]);

    const exactlyOne = (conn1Success && !conn2Success) || (!conn1Success && conn2Success);
    const countIsOne = Number(activeAssignments.rows[0].count) === 1;

    record({
      id: 'PG-H1',
      group: 'Group H: Concurrency Double-Dispatch',
      scenario: 'Two concurrent connections attempt assigning same order to distinct manifests',
      connections: 2,
      operation: 'INSERT INTO transit_manifest_items concurrently',
      expected: 'Exactly ONE commits; second connection waits on order lock and aborts with duplicate conflict',
      actual: `Conn1: ${conn1Success ? 'COMMIT' : 'REJECTED (' + conn1Err + ')'}, Conn2: ${conn2Success ? 'COMMIT' : 'REJECTED (' + conn2Err + ')'}; Active count: ${activeAssignments.rows[0].count}`,
      status: exactlyOne && countIsOne ? 'PASS' : 'FAIL',
    });

    // ========================================================================
    // TEST GROUP I — PARENT ROUTE VS CHILD INSERT CONCURRENCY (DUAL CONNECTIONS)
    // ========================================================================
    console.log('--- Executing Test Group I (Parent Route vs Child Insert Concurrency) ---');
    const manI = '66666666-aaaa-caaa-0001-000000000001';
    await createDbManifest(manI, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-I-ROUTE');

    const orderI = '55555555-aaaa-caaa-0001-000000000001';
    await createDbOrder(orderI, ORG_A, BRANCH_A1, CENTRAL_A, 'ORD-I-CONC');

    const c1 = await pool.connect();
    const c2 = await pool.connect();

    let routeUpdateCommitted = false;
    let itemInsertCommitted = false;

    // Concurrently execute:
    // C1: Update manifest source_branch_id to BRANCH_A2
    // C2: Insert item with order from BRANCH_A1
    await Promise.all([
      (async () => {
        try {
          await c1.query('BEGIN');
          await c1.query('UPDATE transit_manifests SET source_branch_id = $1 WHERE id = $2', [BRANCH_A2, manI]);
          await new Promise(r => setTimeout(r, 40));
          await c1.query('COMMIT');
          routeUpdateCommitted = true;
        } catch (err) {
          await c1.query('ROLLBACK');
        }
      })(),
      (async () => {
        try {
          await c2.query('BEGIN');
          await c2.query(`
            INSERT INTO transit_manifest_items (manifest_id, organization_id, order_id, received_status)
            VALUES ($1, $2, $3, 'EXPECTED')
          `, [manI, ORG_A, orderI]);
          await c2.query('COMMIT');
          itemInsertCommitted = true;
        } catch (err) {
          await c2.query('ROLLBACK');
        }
      })(),
    ]);

    c1.release();
    c2.release();

    // Verify final invariant: Every child item must match manifest source branch
    const finalItemsI = await client.query(`
      SELECT tmi.order_id, o.branch_id AS order_branch, tm.source_branch_id AS manifest_source
      FROM transit_manifest_items tmi
      JOIN orders o ON o.id = tmi.order_id
      JOIN transit_manifests tm ON tm.id = tmi.manifest_id
      WHERE tmi.manifest_id = $1
    `, [manI]);

    let invariantPreserved = true;
    for (const row of finalItemsI.rows) {
      if (row.order_branch !== row.manifest_source) {
        invariantPreserved = false;
      }
    }

    record({
      id: 'PG-I1',
      group: 'Group I: Concurrency Route vs Insert',
      scenario: 'Concurrent route update (A1->A2) vs item insert (order A1)',
      connections: 2,
      operation: 'UPDATE manifest.source_branch_id || INSERT manifest_item',
      expected: 'Invariant strictly preserved: order.branch_id == manifest.source_branch_id',
      actual: `Route committed: ${routeUpdateCommitted}, Item committed: ${itemInsertCommitted}, Invariant valid: ${invariantPreserved}`,
      status: invariantPreserved ? 'PASS' : 'FAIL',
    });

    // ========================================================================
    // TEST GROUP J — CONCURRENT RECEIVING (DUAL CONNECTIONS)
    // ========================================================================
    console.log('--- Executing Test Group J (Concurrent Receiving) ---');
    const manJ = '66666666-aaaa-daaa-0001-000000000001';
    const orderJ = '55555555-aaaa-daaa-0001-000000000001';
    await createDbOrder(orderJ, ORG_A, BRANCH_A1, CENTRAL_A, 'ORD-J-CONC');
    await createManifestWithItems(manJ, ORG_A, BRANCH_A1, CENTRAL_A, 'TRX-J-RECV', [orderJ], 'IN_TRANSIT', USER_A_DRIVER);

    const jConn1 = await pool.connect();
    const jConn2 = await pool.connect();
    await jConn1.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [USER_A_OPERATOR]);
    await jConn2.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [USER_A_OPERATOR]);

    let j1Ok = false;
    let j2Ok = false;

    await Promise.all([
      (async () => {
        try {
          await jConn1.query(`SELECT receive_manifest_with_discrepancy($1, $2::jsonb, $3)`, [
            manJ,
            JSON.stringify([{ order_id: orderJ, status: 'RECEIVED_OK' }]),
            'Receive thread 1'
          ]);
          j1Ok = true;
        } catch (err) {
          // Expected for second thread
        }
      })(),
      (async () => {
        try {
          await jConn2.query(`SELECT receive_manifest_with_discrepancy($1, $2::jsonb, $3)`, [
            manJ,
            JSON.stringify([{ order_id: orderJ, status: 'RECEIVED_OK' }]),
            'Receive thread 2'
          ]);
          j2Ok = true;
        } catch (err) {
          // Expected for second thread
        }
      })(),
    ]);

    jConn1.release();
    jConn2.release();

    const jHistory = await client.query("SELECT count(*) FROM transit_manifest_history WHERE manifest_id = $1 AND to_status = 'RECEIVED'", [manJ]);
    const jStatus = await client.query('SELECT status FROM transit_manifests WHERE id = $1', [manJ]);

    const singleReceive = (j1Ok && !j2Ok) || (!j1Ok && j2Ok);
    const historyClean = Number(jHistory.rows[0].count) === 1;

    record({
      id: 'PG-J1',
      group: 'Group J: Concurrency Receiving',
      scenario: 'Two concurrent connections attempt receive_manifest_with_discrepancy on same manifest',
      connections: 2,
      operation: 'receive_manifest_with_discrepancy concurrently',
      expected: 'Exactly ONE succeeds; second connection detects manifest no longer IN_TRANSIT and aborts',
      actual: `Conn1: ${j1Ok ? 'OK' : 'REJECTED'}, Conn2: ${j2Ok ? 'OK' : 'REJECTED'}; Received status count: ${jHistory.rows[0].count}`,
      status: singleReceive && historyClean && jStatus.rows[0].status === 'RECEIVED' ? 'PASS' : 'FAIL',
    });

    // ========================================================================
    // TEST GROUP K — ROW LEVEL SECURITY (RLS) RUNTIME VERIFICATION
    // ========================================================================
    console.log('--- Executing Test Group K (RLS Runtime Verification) ---');
    const rlsClient = await pool.connect();

    // 1. Act as authenticated Org A Cashier at Branch A1
    await rlsClient.query('SET ROLE authenticated');
    await rlsClient.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [USER_A_A1]);
    await rlsClient.query("SELECT set_config('request.jwt.claim', $1, false)", [JSON.stringify({ app_metadata: { organization_id: ORG_A } })]);

    // Select manifests: should see Org A manifests, but ZERO Org B manifests
    const orgBQuery = await rlsClient.query('SELECT * FROM transit_manifests WHERE organization_id = $1', [ORG_B]);
    const orgAQuery = await rlsClient.query('SELECT * FROM transit_manifests WHERE organization_id = $1', [ORG_A]);

    const rlsOrgBBlocked = orgBQuery.rows.length === 0;
    const rlsOrgAVisible = orgAQuery.rows.length > 0;

    record({
      id: 'PG-K1',
      group: 'Group K: RLS Runtime',
      scenario: 'Authenticated User Org A queries manifests: cross-tenant read isolation',
      connections: 1,
      operation: 'SELECT * FROM transit_manifests (as Org A user)',
      expected: 'Returns Org A manifests; returns 0 rows for Org B',
      actual: `Org A rows: ${orgAQuery.rows.length}, Org B rows: ${orgBQuery.rows.length}`,
      status: rlsOrgBBlocked && rlsOrgAVisible ? 'PASS' : 'FAIL',
    });

    // 2. Viewer cannot insert manifest (denied by branch access / insert check)
    await rlsClient.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [USER_A_VIEWER]);
    let viewerInsertBlocked = false;
    try {
      await rlsClient.query(`
        INSERT INTO transit_manifests (organization_id, manifest_number, source_branch_id, destination_branch_id, status, created_by)
        VALUES ($1, 'TRX-VIEWER', $2, $3, 'DRAFT', $4)
      `, [ORG_A, BRANCH_A1, CENTRAL_A, USER_A_VIEWER]);
    } catch (err) {
      viewerInsertBlocked = err.message.includes('violates row-level security policy') || err.message.includes('policy');
    }

    record({
      id: 'PG-K2',
      group: 'Group K: RLS Runtime',
      scenario: 'User without write branch access attempts direct INSERT into transit_manifests',
      connections: 1,
      operation: 'INSERT INTO transit_manifests (as Viewer without branch access)',
      expected: 'REJECT by RLS WITH CHECK policy',
      actual: viewerInsertBlocked ? 'REJECTED by RLS policy' : 'INSERT SUCCEEDED (Policy breach!)',
      status: viewerInsertBlocked ? 'PASS' : 'FAIL',
    });

    await rlsClient.query('RESET ROLE');
    rlsClient.release();

    // ========================================================================
    // TEST GROUP L — SECURITY DEFINER RPC VERIFICATION
    // ========================================================================
    console.log('--- Executing Test Group L (SECURITY DEFINER RPCs) ---');
    const rpcClient = await pool.connect();
    await rpcClient.query('SET ROLE authenticated');

    // 1. Authorized call to create_manifest_with_orders
    await rpcClient.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [USER_A_A1]);
    await rpcClient.query("SELECT set_config('request.jwt.claim', $1, false)", [JSON.stringify({ app_metadata: { organization_id: ORG_A } })]);

    const orderL1 = '55555555-aaaa-1111-0009-000000000001';
    await client.query(`
      INSERT INTO orders (id, organization_id, branch_id, production_branch_id, customer_id, order_number, tracking_token, status, operating_mode, subtotal, final_amount, paid_amount, payment_status, promised_ready_at, created_by)
      VALUES ($1, $2, $3, $4, $5, 'ORD-L-01', 'trk_l_01', 'RECEIVED', 'SIMPLE', 10000, 10000, 10000, 'PAID', NOW() + INTERVAL '24 hours', $6)
    `, [orderL1, ORG_A, BRANCH_A1, CENTRAL_A, CUST_A, USER_A_A1]);

    let createRpcSuccess = false;
    try {
      const res = await rpcClient.query(`
        SELECT create_manifest_with_orders('TRX-L-RPC', $1, $2, $3, 'B 1111 RPC', 'Notes', ARRAY[$4]::uuid[])
      `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderL1]);
      createRpcSuccess = res.rows[0].create_manifest_with_orders.success === true;
    } catch (err) {
      console.log('Error create_manifest_with_orders:', err.message);
    }

    // 2. Unauthorized branch access call
    let unauthorizedBranchBlocked = false;
    try {
      // User A1 has access to BRANCH_A1, NOT BRANCH_A2
      await rpcClient.query(`
        SELECT create_manifest_with_orders('TRX-L-UNAUTH', $1, $2, $3, 'B 1111 RPC', 'Notes', NULL)
      `, [BRANCH_A2, CENTRAL_A, USER_A_DRIVER]);
    } catch (err) {
      unauthorizedBranchBlocked = err.message.includes('Access denied for source branch');
    }

    // 3. Cross-tenant order attach via RPC
    let crossTenantRpcBlocked = false;
    try {
      await rpcClient.query(`
        SELECT create_manifest_with_orders('TRX-L-XTENANT', $1, $2, $3, 'B 1111 RPC', 'Notes', ARRAY[$4]::uuid[])
      `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderB1_1]);
    } catch (err) {
      crossTenantRpcBlocked = err.message.includes('different organization') || err.message.includes('Cross-tenant') || err.message.includes('belong');
    }

    if (!createRpcSuccess || !unauthorizedBranchBlocked || !crossTenantRpcBlocked) {
      console.log('PG-L1 debug:', { createRpcSuccess, unauthorizedBranchBlocked, crossTenantRpcBlocked });
    }

    await rpcClient.query('RESET ROLE');
    rpcClient.release();

    record({
      id: 'PG-L1',
      group: 'Group L: RPC Security',
      scenario: 'SECURITY DEFINER RPC create_manifest_with_orders execution and authorization guards',
      connections: 1,
      operation: 'create_manifest_with_orders RPC',
      expected: 'Authorized succeeds; unauthorized branch rejected; cross-tenant order rejected',
      actual: createRpcSuccess && unauthorizedBranchBlocked && crossTenantRpcBlocked ? 'ALL GUARDS ENFORCED' : 'FAIL',
      status: createRpcSuccess && unauthorizedBranchBlocked && crossTenantRpcBlocked ? 'PASS' : 'FAIL',
    });

    // ========================================================================
    // TEST GROUP M — ROLLBACK / FAILURE INJECTION RE-CHECK
    // ========================================================================
    console.log('--- Executing Test Group M (Final Invariant Cleanliness) ---');
    // 1. Check for any orphan manifest items
    const orphanItems = await client.query(`
      SELECT count(*) FROM transit_manifest_items tmi
      LEFT JOIN transit_manifests tm ON tm.id = tmi.manifest_id
      LEFT JOIN orders o ON o.id = tmi.order_id
      WHERE tm.id IS NULL OR o.id IS NULL
    `);

    // 2. Check for cross-tenant violations across all items
    const crossTenantInDB = await client.query(`
      SELECT count(*) FROM transit_manifest_items tmi
      JOIN transit_manifests tm ON tm.id = tmi.manifest_id
      JOIN orders o ON o.id = tmi.order_id
      WHERE tmi.organization_id <> tm.organization_id OR o.organization_id <> tm.organization_id
    `);

    // 3. Check for cross-branch violations in the entire database (accounting for directed routing)
    const crossBranchInDB = await client.query(`
      SELECT count(*) FROM transit_manifest_items tmi
      JOIN transit_manifests tm ON tm.id = tmi.manifest_id
      JOIN orders o ON o.id = tmi.order_id
      WHERE NOT (
        (o.branch_id = tm.source_branch_id AND o.production_branch_id = tm.destination_branch_id)
        OR
        (o.production_branch_id = tm.source_branch_id AND o.branch_id = tm.destination_branch_id)
      )
    `);

    // 4. Check for duplicate active assignments
    const dupActiveInDB = await client.query(`
      SELECT count(*) FROM (
        SELECT tmi.order_id FROM transit_manifest_items tmi
        JOIN transit_manifests tm ON tm.id = tmi.manifest_id
        WHERE tm.status IN ('DRAFT', 'READY_TO_DISPATCH', 'IN_TRANSIT')
        GROUP BY tmi.order_id HAVING count(*) > 1
      ) d
    `);

    const noOrphans = Number(orphanItems.rows[0].count) === 0;
    const noCrossTenant = Number(crossTenantInDB.rows[0].count) === 0;
    const noCrossBranch = Number(crossBranchInDB.rows[0].count) === 0;
    const noDupActive = Number(dupActiveInDB.rows[0].count) === 0;

    const allInvariantsPassed = noOrphans && noCrossTenant && noCrossBranch && noDupActive;

    record({
      id: 'PG-M1',
      group: 'Group M: Invariant Cleanliness',
      scenario: 'Database global invariant audit after high-stress concurrency and failure injections',
      connections: 1,
      operation: 'Integrity scan across all committed rows',
      expected: 'Zero orphan items; zero cross-tenant items; zero cross-branch records; zero duplicate active assignments',
      actual: `Orphans: ${orphanItems.rows[0].count}, Cross-tenant: ${crossTenantInDB.rows[0].count}, Cross-branch: ${crossBranchInDB.rows[0].count}, Dup active: ${dupActiveInDB.rows[0].count}`,
      status: allInvariantsPassed ? 'PASS' : 'FAIL',
    });

    // ========================================================================
    // TEST GROUP N — DIRECTED TRANSIT ROUTING (STEP 4B.5 / MODEL C)
    // ========================================================================
    console.log('\n--- Executing Test Group N (Directed Transit Routing Runtime) ---');

    // Setup an isolated order at BRANCH_A1 with CENTRAL_A as production workshop
    const orderN1Res = await client.query(`
      INSERT INTO orders (
        organization_id, branch_id, production_branch_id, customer_id, order_number, tracking_token, status, promised_ready_at, created_by
      ) VALUES (
        $1, $2, $3, $4, 'ORD-N-ROUTING-001', 'trk-n-routing-001', 'RECEIVED', NOW() + INTERVAL '2 days', $5
      ) RETURNING id
    `, [ORG_A, BRANCH_A1, CENTRAL_A, CUST_A, USER_A_A1]);
    const orderN1 = orderN1Res.rows[0].id;

    // Attach initial payment at BRANCH_A1
    await client.query(`
      INSERT INTO payments (organization_id, branch_id, order_id, payment_method, amount, received_by)
      VALUES ($1, $2, $3, 'CASH', 50000, $4)
    `, [ORG_A, BRANCH_A1, orderN1, USER_A_A1]);

    const nClient = await pool.connect();
    await nClient.query('SET ROLE authenticated');
    await nClient.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [USER_A_OWNER]);
    await nClient.query("SELECT set_config('request.jwt.claim', $1, false)", [JSON.stringify({ app_metadata: { organization_id: ORG_A } })]);

    // N-01: Outbound invalid destination (A1 -> A2, while production is CENTRAL_A)
    let n01Blocked = false;
    try {
      await nClient.query(`
        SELECT create_manifest_with_orders('TRX-N01', $1, $2, $3, 'B 9999 N01', 'Invalid Dest', ARRAY[$4]::uuid[])
      `, [BRANCH_A1, BRANCH_A2, USER_A_DRIVER, orderN1]);
    } catch (err) {
      n01Blocked = err.message.includes('Outbound route violation') || err.message.includes('cannot be dispatched');
    }
    record({
      id: 'PG-N1',
      group: 'Group N: Directed Routing',
      scenario: 'Outbound manifest with wrong destination rejected by DB',
      connections: 1,
      operation: 'create_manifest_with_orders (A1 -> A2, prod=CENTRAL_A)',
      expected: 'Rejection with Outbound route violation',
      actual: n01Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: n01Blocked ? 'PASS' : 'FAIL',
    });

    // N-02: Return invalid before outbound is received (CENTRAL_A -> BRANCH_A1)
    let n02Blocked = false;
    try {
      await nClient.query(`
        SELECT create_manifest_with_orders('TRX-N02', $1, $2, $3, 'B 9999 N02', 'Premature Return', ARRAY[$4]::uuid[])
      `, [CENTRAL_A, BRANCH_A1, USER_A_DRIVER, orderN1]);
    } catch (err) {
      n02Blocked = err.message.includes('Return route violation') || err.message.includes('no prior RECEIVED outbound');
    }
    record({
      id: 'PG-N2',
      group: 'Group N: Directed Routing',
      scenario: 'Return manifest rejected before outbound transit is received',
      connections: 1,
      operation: 'create_manifest_with_orders (CENTRAL_A -> A1 before outbound)',
      expected: 'Rejection with Return route violation',
      actual: n02Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: n02Blocked ? 'PASS' : 'FAIL',
    });

    // N-03: Outbound valid creation (BRANCH_A1 -> CENTRAL_A)
    const n03Res = await nClient.query(`
      SELECT create_manifest_with_orders('TRX-N03', $1, $2, $3, 'B 9999 N03', 'Valid Outbound', ARRAY[$4]::uuid[])
    `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderN1]);
    const manOutId = n03Res.rows[0].create_manifest_with_orders.manifest_id;

    record({
      id: 'PG-N3',
      group: 'Group N: Directed Routing',
      scenario: 'Valid outbound manifest created successfully',
      connections: 1,
      operation: 'create_manifest_with_orders (A1 -> CENTRAL_A)',
      expected: 'Manifest created in DRAFT with 1 order',
      actual: manOutId ? 'CREATED' : 'FAIL',
      status: manOutId ? 'PASS' : 'FAIL',
    });

    // Transition Outbound to IN_TRANSIT
    await client.query(`UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1`, [manOutId]);
    await client.query(`UPDATE transit_manifests SET status = 'IN_TRANSIT', dispatched_at = NOW() WHERE id = $1`, [manOutId]);

    // N-04: Return rejected while outbound is still IN_TRANSIT
    let n04Blocked = false;
    try {
      await nClient.query(`
        SELECT create_manifest_with_orders('TRX-N04', $1, $2, $3, 'B 9999 N04', 'In-Transit Return', ARRAY[$4]::uuid[])
      `, [CENTRAL_A, BRANCH_A1, USER_A_DRIVER, orderN1]);
    } catch (err) {
      n04Blocked = err.message.includes('active manifest') || err.message.includes('Return route violation');
    }
    record({
      id: 'PG-N4',
      group: 'Group N: Directed Routing',
      scenario: 'Return manifest rejected while outbound is still IN_TRANSIT (active manifest guard)',
      connections: 1,
      operation: 'create_manifest_with_orders (CENTRAL_A -> A1 while in-transit)',
      expected: 'Rejection due to active manifest or unreceived outbound',
      actual: n04Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: n04Blocked ? 'PASS' : 'FAIL',
    });

    // Receive Outbound at CENTRAL_A using receive_manifest_with_discrepancy RPC
    await nClient.query(`
      SELECT receive_manifest_with_discrepancy(
        $1,
        jsonb_build_array(jsonb_build_object('order_id', $2::text, 'status', 'RECEIVED_OK', 'notes', 'Kondisi baik')),
        'Diterima workshop'
      )
    `, [manOutId, orderN1]);

    // N-05: Re-eligibility check: cannot dispatch outbound again (A1 -> CENTRAL_A) while in workshop
    let n05Blocked = false;
    try {
      await nClient.query(`
        SELECT create_manifest_with_orders('TRX-N05', $1, $2, $3, 'B 9999 N05', 'Re-Outbound attempt', ARRAY[$4]::uuid[])
      `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderN1]);
    } catch (err) {
      n05Blocked = err.message.includes('Outbound route violation') || err.message.includes('already been received at production branch');
    }
    record({
      id: 'PG-N5',
      group: 'Group N: Directed Routing',
      scenario: 'Re-eligibility anomaly resolved: received outbound order cannot be re-dispatched outbound',
      connections: 1,
      operation: 'create_manifest_with_orders (A1 -> CENTRAL_A duplicate outbound)',
      expected: 'Rejection with Outbound route violation (already in workshop)',
      actual: n05Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: n05Blocked ? 'PASS' : 'FAIL',
    });

    // N-06: Return invalid destination (CENTRAL_A -> A2, while origin is A1)
    let n06Blocked = false;
    try {
      await nClient.query(`
        SELECT create_manifest_with_orders('TRX-N06', $1, $2, $3, 'B 9999 N06', 'Wrong Return Dest', ARRAY[$4]::uuid[])
      `, [CENTRAL_A, BRANCH_A2, USER_A_DRIVER, orderN1]);
    } catch (err) {
      n06Blocked = err.message.includes('Return route violation') || err.message.includes('cannot be returned to destination branch');
    }
    record({
      id: 'PG-N6',
      group: 'Group N: Directed Routing',
      scenario: 'Return manifest to wrong outlet branch rejected',
      connections: 1,
      operation: 'create_manifest_with_orders (CENTRAL_A -> A2, origin is A1)',
      expected: 'Rejection with Return route violation',
      actual: n06Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: n06Blocked ? 'PASS' : 'FAIL',
    });

    // N-07: Valid Return Manifest creation (CENTRAL_A -> BRANCH_A1)
    const n07Res = await nClient.query(`
      SELECT create_manifest_with_orders('TRX-N07', $1, $2, $3, 'B 9999 N07', 'Valid Return', ARRAY[$4]::uuid[])
    `, [CENTRAL_A, BRANCH_A1, USER_A_DRIVER, orderN1]);
    const manRetId = n07Res.rows[0].create_manifest_with_orders.manifest_id;

    record({
      id: 'PG-N7',
      group: 'Group N: Directed Routing',
      scenario: 'Valid return manifest created after outbound receipt',
      connections: 1,
      operation: 'create_manifest_with_orders (CENTRAL_A -> A1)',
      expected: 'Manifest created in DRAFT',
      actual: manRetId ? 'CREATED' : 'FAIL',
      status: manRetId ? 'PASS' : 'FAIL',
    });

    // Transition Return to IN_TRANSIT and Receive at BRANCH_A1
    await client.query(`UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1`, [manRetId]);
    await client.query(`UPDATE transit_manifests SET status = 'IN_TRANSIT', dispatched_at = NOW() WHERE id = $1`, [manRetId]);
    await nClient.query(`
      SELECT receive_manifest_with_discrepancy(
        $1,
        jsonb_build_array(jsonb_build_object('order_id', $2::text, 'status', 'RECEIVED_OK', 'notes', 'Kembali ke outlet')),
        'Diterima di outlet'
      )
    `, [manRetId, orderN1]);

    // N-08: Duplicate return rejected
    let n08Blocked = false;
    try {
      await nClient.query(`
        SELECT create_manifest_with_orders('TRX-N08', $1, $2, $3, 'B 9999 N08', 'Duplicate Return', ARRAY[$4]::uuid[])
      `, [CENTRAL_A, BRANCH_A1, USER_A_DRIVER, orderN1]);
    } catch (err) {
      n08Blocked = err.message.includes('Return route violation') || err.message.includes('already been returned');
    }
    record({
      id: 'PG-N8',
      group: 'Group N: Directed Routing',
      scenario: 'Duplicate return manifest rejected after completion of return cycle',
      connections: 1,
      operation: 'create_manifest_with_orders (CENTRAL_A -> A1 duplicate return)',
      expected: 'Rejection with Return route violation (already returned)',
      actual: n08Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: n08Blocked ? 'PASS' : 'FAIL',
    });

    await nClient.query('RESET ROLE');
    nClient.release();

    // N-09: Financial and Origin Anchor Invariant Verification
    const postRoundTripOrder = await client.query(`
      SELECT branch_id, production_branch_id, status FROM orders WHERE id = $1
    `, [orderN1]);
    const postRoundTripPayments = await client.query(`
      SELECT branch_id FROM payments WHERE order_id = $1
    `, [orderN1]);

    const ordRow = postRoundTripOrder.rows[0];
    const payRow = postRoundTripPayments.rows[0];

    const branchIntact = ordRow.branch_id === BRANCH_A1;
    const prodIntact = ordRow.production_branch_id === CENTRAL_A;
    const paymentBranchIntact = payRow.branch_id === BRANCH_A1;

    record({
      id: 'PG-N9',
      group: 'Group N: Directed Routing',
      scenario: 'Post-round-trip invariant: orders.branch_id, production_branch_id, and payments.branch_id remain intact',
      connections: 1,
      operation: 'Verification of orders and payments tables post-round-trip',
      expected: 'orders.branch_id = A1, production_branch_id = CENTRAL_A, payments.branch_id = A1',
      actual: `orders.branch_id: ${ordRow.branch_id}, prod_id: ${ordRow.production_branch_id}, payments.branch_id: ${payRow.branch_id}`,
      status: branchIntact && prodIntact && paymentBranchIntact ? 'PASS' : 'FAIL',
    });

    // ==========================================================================
    // GROUP O: Multi-Cycle Transit & Rework Gate Enforcement (Step 4B.6.2)
    // ==========================================================================
    console.log('\n--- Running Group O: Multi-Cycle Transit & Rework Gate Enforcement ---');

    const oClient = await pool.connect();
    await oClient.query('SET ROLE authenticated');
    await oClient.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [USER_A_OWNER]);
    await oClient.query("SELECT set_config('request.jwt.claim', $1, false)", [JSON.stringify({ app_metadata: { organization_id: ORG_A } })]);

    // Setup orderO1
    const resO1 = await client.query(`
      INSERT INTO orders (
        organization_id, branch_id, production_branch_id, customer_id, order_number, tracking_token,
        status, operating_mode, subtotal, final_amount, paid_amount, payment_status, promised_ready_at, created_by
      ) VALUES (
        $1, $2, $3, $4, 'ORD-MC-001', 'trk-mc-001',
        'RECEIVED', 'SIMPLE', 85000, 85000, 85000, 'PAID', NOW() + INTERVAL '24 hours', $5
      ) RETURNING id
    `, [ORG_A, BRANCH_A1, CENTRAL_A, CUST_A, USER_A_A1]);
    const orderO1 = resO1.rows[0].id;

    await client.query(`
      INSERT INTO payments (organization_id, branch_id, order_id, payment_method, amount, received_by)
      VALUES ($1, $2, $3, 'CASH', 85000, $4)
    `, [ORG_A, BRANCH_A1, orderO1, USER_A_A1]);

    // PG-O1: Cycle 1 Outbound works without rework authorization
    let manO1Id = null;
    let o01Error = null;
    try {
      const res = await oClient.query(`
        SELECT create_manifest_with_orders('TRX-O01', $1, $2, $3, 'B 1111 O1', 'Cycle 1 Outbound', ARRAY[$4]::uuid[])
      `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO1]);
      manO1Id = res.rows[0].create_manifest_with_orders.manifest_id;
    } catch (err) {
      o01Error = err.message;
    }
    record({
      id: 'PG-O1',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Cycle 1 Outbound works without rework authorization',
      connections: 1,
      operation: 'create_manifest_with_orders (A1 -> CENTRAL_A, Cycle 1)',
      expected: 'Manifest created in DRAFT without error',
      actual: manO1Id ? 'CREATED' : `ERROR: ${o01Error}`,
      status: manO1Id ? 'PASS' : 'FAIL',
    });

    // Transition TRX-O01 to IN_TRANSIT
    await client.query(`UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1`, [manO1Id]);
    await client.query(`UPDATE transit_manifests SET status = 'IN_TRANSIT', dispatched_at = NOW() WHERE id = $1`, [manO1Id]);

    // PG-O2: Outbound while in transit (en route) rejected
    let o02Blocked = false;
    try {
      await oClient.query(`
        SELECT create_manifest_with_orders('TRX-O02', $1, $2, $3, 'B 1111 O2', 'En route dispatch attempt', ARRAY[$4]::uuid[])
      `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO1]);
    } catch (err) {
      o02Blocked = err.message.includes('already assigned to an active manifest');
    }
    record({
      id: 'PG-O2',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Outbound dispatch while order is en route in transit rejected',
      connections: 1,
      operation: 'create_manifest_with_orders while IN_TRANSIT',
      expected: 'Rejection with active manifest error',
      actual: o02Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: o02Blocked ? 'PASS' : 'FAIL',
    });

    // Receive TRX-O01 at CENTRAL_A
    await oClient.query(`
      SELECT receive_manifest_with_discrepancy(
        $1,
        jsonb_build_array(jsonb_build_object('order_id', $2::text, 'status', 'RECEIVED_OK', 'notes', 'Diterima di workshop')),
        'Tiba di central workshop'
      )
    `, [manO1Id, orderO1]);

    // PG-O3: Outbound while at workshop rejected
    let o03Blocked = false;
    try {
      await oClient.query(`
        SELECT create_manifest_with_orders('TRX-O03', $1, $2, $3, 'B 1111 O3', 'Outbound while at workshop', ARRAY[$4]::uuid[])
      `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO1]);
    } catch (err) {
      o03Blocked = err.message.includes('Outbound route violation') && err.message.includes('has not been returned');
    }
    record({
      id: 'PG-O3',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Outbound dispatch while order is physically at workshop rejected',
      connections: 1,
      operation: 'create_manifest_with_orders (A1 -> CENTRAL_A while at CENTRAL_A)',
      expected: 'Rejection: Order is at production branch and has not been returned',
      actual: o03Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: o03Blocked ? 'PASS' : 'FAIL',
    });

    // Create Return manifest TRX-O04 (CENTRAL_A -> BRANCH_A1)
    const resRetO1 = await oClient.query(`
      SELECT create_manifest_with_orders('TRX-O04', $1, $2, $3, 'B 1111 O4', 'Return Cycle 1', ARRAY[$4]::uuid[])
    `, [CENTRAL_A, BRANCH_A1, USER_A_DRIVER, orderO1]);
    const manO4Id = resRetO1.rows[0].create_manifest_with_orders.manifest_id;

    // Dispatch Return TRX-O04 to IN_TRANSIT
    await client.query(`UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1`, [manO4Id]);
    await client.query(`UPDATE transit_manifests SET status = 'IN_TRANSIT', dispatched_at = NOW() WHERE id = $1`, [manO4Id]);

    // PG-O4: Return while in return transit rejected
    let o04Blocked = false;
    try {
      await oClient.query(`
        SELECT create_manifest_with_orders('TRX-O04-DUP', $1, $2, $3, 'B 1111 O4D', 'Duplicate Return En Route', ARRAY[$4]::uuid[])
      `, [CENTRAL_A, BRANCH_A1, USER_A_DRIVER, orderO1]);
    } catch (err) {
      o04Blocked = err.message.includes('already assigned to an active manifest');
    }
    record({
      id: 'PG-O4',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Return dispatch while order is already in return transit rejected',
      connections: 1,
      operation: 'create_manifest_with_orders while Return IN_TRANSIT',
      expected: 'Rejection with active manifest error',
      actual: o04Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: o04Blocked ? 'PASS' : 'FAIL',
    });

    // PG-O5: Return to non-origin branch rejected
    const resO_wrong = await client.query(`
      INSERT INTO orders (
        organization_id, branch_id, production_branch_id, customer_id, order_number, tracking_token,
        status, operating_mode, subtotal, final_amount, paid_amount, payment_status, promised_ready_at, created_by
      ) VALUES ($1, $2, $3, $4, 'ORD-WR-001', 'trk-wr-001', 'RECEIVED', 'SIMPLE', 50000, 50000, 50000, 'PAID', NOW() + INTERVAL '24 hours', $5)
      RETURNING id
    `, [ORG_A, BRANCH_A1, CENTRAL_A, CUST_A, USER_A_A1]);
    const orderO_wrong = resO_wrong.rows[0].id;

    const resM_wrong = await oClient.query(`
      SELECT create_manifest_with_orders('TRX-WRONG-1', $1, $2, $3, 'B 9999 WR1', 'Outbound', ARRAY[$4]::uuid[])
    `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO_wrong]);
    await client.query(`UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1`, [resM_wrong.rows[0].create_manifest_with_orders.manifest_id]);
    await client.query(`UPDATE transit_manifests SET status = 'IN_TRANSIT', dispatched_at = NOW() WHERE id = $1`, [resM_wrong.rows[0].create_manifest_with_orders.manifest_id]);
    await oClient.query(`
      SELECT receive_manifest_with_discrepancy(
        $1,
        jsonb_build_array(jsonb_build_object('order_id', $2::text, 'status', 'RECEIVED_OK', 'notes', 'ok')),
        'Tiba'
      )
    `, [resM_wrong.rows[0].create_manifest_with_orders.manifest_id, orderO_wrong]);

    let o05Blocked = false;
    try {
      await oClient.query(`
        SELECT create_manifest_with_orders('TRX-WRONG-2', $1, $2, $3, 'B 9999 WR2', 'Return to wrong branch', ARRAY[$4]::uuid[])
      `, [CENTRAL_A, BRANCH_A2, USER_A_DRIVER, orderO_wrong]);
    } catch (err) {
      o05Blocked = err.message.includes('Return route violation') && err.message.includes('cannot be returned to destination branch');
    }
    record({
      id: 'PG-O5',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Return to non-origin branch rejected',
      connections: 1,
      operation: 'create_manifest_with_orders (CENTRAL_A -> BRANCH_A2 for A1 order)',
      expected: 'Rejection: Return destination must match commercial origin',
      actual: o05Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: o05Blocked ? 'PASS' : 'FAIL',
    });

    // Receive Return TRX-O04 at BRANCH_A1 (Cycle 1 complete!)
    await oClient.query(`
      SELECT receive_manifest_with_discrepancy(
        $1,
        jsonb_build_array(jsonb_build_object('order_id', $2::text, 'status', 'RECEIVED_OK', 'notes', 'Kembali ke outlet')),
        'Tiba di outlet'
      )
    `, [manO4Id, orderO1]);

    // PG-O6: Cycle 2 Outbound without rework authorization rejected
    let o06Blocked = false;
    let o06Msg = '';
    try {
      await oClient.query(`
        SELECT create_manifest_with_orders('TRX-O06', $1, $2, $3, 'B 1111 O6', 'Cycle 2 without auth', ARRAY[$4]::uuid[])
      `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO1]);
    } catch (err) {
      o06Msg = err.message;
      o06Blocked = err.message.includes('requires an active approved rework request');
    }
    record({
      id: 'PG-O6',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Cycle 2 Outbound without active approved rework authorization rejected',
      connections: 1,
      operation: 'create_manifest_with_orders (Cycle 2 Outbound without rework auth)',
      expected: 'Rejection: requires an active approved rework request',
      actual: o06Blocked ? 'REJECTED' : `NOT BLOCKED (${o06Msg})`,
      status: o06Blocked ? 'PASS' : 'FAIL',
    });

    // PG-O7: Creation of order_rework_requests in APPROVED status succeeds
    let reworkO1Id = null;
    try {
      const resRw = await oClient.query(`
        SELECT create_order_rework_request($1, 'CUSTOMER_COMPLAINT', 'Customer noted stain on collar')
      `, [orderO1]);
      reworkO1Id = resRw.rows[0].create_order_rework_request.rework_request_id;
    } catch (err) {
      console.error('PG-O7 error:', err.message);
    }
    record({
      id: 'PG-O7',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Creation of order_rework_requests in APPROVED status succeeds',
      connections: 1,
      operation: 'create_order_rework_request(orderO1, CUSTOMER_COMPLAINT)',
      expected: 'Request created with status APPROVED',
      actual: reworkO1Id ? 'APPROVED' : 'FAIL',
      status: reworkO1Id ? 'PASS' : 'FAIL',
    });

    // PG-O8: Cycle 2 Outbound with APPROVED request succeeds; token transitioned to CONSUMED
    let manO8Id = null;
    try {
      const res = await oClient.query(`
        SELECT create_manifest_with_orders('TRX-O08', $1, $2, $3, 'B 1111 O8', 'Cycle 2 Outbound Authorized', ARRAY[$4]::uuid[])
      `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO1]);
      manO8Id = res.rows[0].create_manifest_with_orders.manifest_id;
    } catch (err) {
      console.error('PG-O8 error:', err.message);
    }

    const rwChk8 = await client.query(`
      SELECT status, consumed_manifest_id FROM order_rework_requests WHERE id = $1
    `, [reworkO1Id]);
    const isConsumed8 = rwChk8.rows[0] && rwChk8.rows[0].status === 'CONSUMED' && rwChk8.rows[0].consumed_manifest_id === manO8Id;

    record({
      id: 'PG-O8',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Cycle 2 Outbound with APPROVED request succeeds and atomically transitions to CONSUMED',
      connections: 1,
      operation: 'create_manifest_with_orders with active rework authorization',
      expected: 'Manifest created and rework request status = CONSUMED',
      actual: manO8Id && isConsumed8 ? 'CONSUMED' : `status: ${rwChk8.rows[0]?.status}`,
      status: manO8Id && isConsumed8 ? 'PASS' : 'FAIL',
    });

    // Complete Cycle 2 round trip
    await client.query(`UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1`, [manO8Id]);
    await client.query(`UPDATE transit_manifests SET status = 'IN_TRANSIT', dispatched_at = NOW() WHERE id = $1`, [manO8Id]);
    await oClient.query(`
      SELECT receive_manifest_with_discrepancy(
        $1,
        jsonb_build_array(jsonb_build_object('order_id', $2::text, 'status', 'RECEIVED_OK', 'notes', 'Rework received at workshop')),
        'Tiba workshop'
      )
    `, [manO8Id, orderO1]);

    const resRetO8 = await oClient.query(`
      SELECT create_manifest_with_orders('TRX-O08-RET', $1, $2, $3, 'B 1111 O8R', 'Return Cycle 2', ARRAY[$4]::uuid[])
    `, [CENTRAL_A, BRANCH_A1, USER_A_DRIVER, orderO1]);
    const manRetO8Id = resRetO8.rows[0].create_manifest_with_orders.manifest_id;
    await client.query(`UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1`, [manRetO8Id]);
    await client.query(`UPDATE transit_manifests SET status = 'IN_TRANSIT', dispatched_at = NOW() WHERE id = $1`, [manRetO8Id]);
    await oClient.query(`
      SELECT receive_manifest_with_discrepancy(
        $1,
        jsonb_build_array(jsonb_build_object('order_id', $2::text, 'status', 'RECEIVED_OK', 'notes', 'Rework return received at outlet')),
        'Tiba outlet'
      )
    `, [manRetO8Id, orderO1]);

    // PG-O9: Double reuse of CONSUMED token rejected
    let o09Blocked = false;
    try {
      await oClient.query(`
        SELECT create_manifest_with_orders('TRX-O09', $1, $2, $3, 'B 1111 O9', 'Cycle 3 using old token', ARRAY[$4]::uuid[])
      `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO1]);
    } catch (err) {
      o09Blocked = err.message.includes('requires an active approved rework request');
    }
    record({
      id: 'PG-O9',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Double reuse of CONSUMED rework token rejected on subsequent outbound cycle',
      connections: 1,
      operation: 'create_manifest_with_orders attempting to reuse consumed token',
      expected: 'Rejection: requires an active approved rework request',
      actual: o09Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: o09Blocked ? 'PASS' : 'FAIL',
    });

    // Setup orderO2 for unique index, cancellation, and concurrency tests
    const resO2 = await client.query(`
      INSERT INTO orders (
        organization_id, branch_id, production_branch_id, customer_id, order_number, tracking_token,
        status, operating_mode, subtotal, final_amount, paid_amount, payment_status, promised_ready_at, created_by
      ) VALUES ($1, $2, $3, $4, 'ORD-MC-002', 'trk-mc-002', 'RECEIVED', 'SIMPLE', 90000, 90000, 90000, 'PAID', NOW() + INTERVAL '24 hours', $5)
      RETURNING id
    `, [ORG_A, BRANCH_A1, CENTRAL_A, CUST_A, USER_A_A1]);
    const orderO2 = resO2.rows[0].id;

    // Cycle 1 for orderO2
    const resM_O2 = await oClient.query(`
      SELECT create_manifest_with_orders('TRX-O2-1', $1, $2, $3, 'B 2222 O2', 'Cycle 1 Outbound', ARRAY[$4]::uuid[])
    `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO2]);
    const manO2Id = resM_O2.rows[0].create_manifest_with_orders.manifest_id;
    await client.query(`UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1`, [manO2Id]);
    await client.query(`UPDATE transit_manifests SET status = 'IN_TRANSIT', dispatched_at = NOW() WHERE id = $1`, [manO2Id]);
    await oClient.query(`
      SELECT receive_manifest_with_discrepancy(
        $1,
        jsonb_build_array(jsonb_build_object('order_id', $2::text, 'status', 'RECEIVED_OK', 'notes', 'ok')),
        'Tiba'
      )
    `, [manO2Id, orderO2]);
    const resRetO2 = await oClient.query(`
      SELECT create_manifest_with_orders('TRX-O2-RET', $1, $2, $3, 'B 2222 O2R', 'Return Cycle 1', ARRAY[$4]::uuid[])
    `, [CENTRAL_A, BRANCH_A1, USER_A_DRIVER, orderO2]);
    await client.query(`UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1`, [resRetO2.rows[0].create_manifest_with_orders.manifest_id]);
    await client.query(`UPDATE transit_manifests SET status = 'IN_TRANSIT', dispatched_at = NOW() WHERE id = $1`, [resRetO2.rows[0].create_manifest_with_orders.manifest_id]);
    await oClient.query(`
      SELECT receive_manifest_with_discrepancy(
        $1,
        jsonb_build_array(jsonb_build_object('order_id', $2::text, 'status', 'RECEIVED_OK', 'notes', 'ok')),
        'Tiba'
      )
    `, [resRetO2.rows[0].create_manifest_with_orders.manifest_id, orderO2]);

    // Create first APPROVED rework request for orderO2
    const resRwO2_1 = await oClient.query(`
      SELECT create_order_rework_request($1, 'STAIN_REMAINS', 'Collar stain persists')
    `, [orderO2]);
    const reworkO2Id = resRwO2_1.rows[0].create_order_rework_request.rework_request_id;

    // PG-O10: Partial unique index idx_order_rework_one_active blocks second concurrent APPROVED request
    let o10Blocked = false;
    try {
      await oClient.query(`
        SELECT create_order_rework_request($1, 'ODOR_REMAINS', 'Duplicate active request')
      `, [orderO2]);
    } catch (err) {
      o10Blocked = err.message.includes('already has an active approved rework request') || err.message.includes('idx_order_rework_one_active');
    }
    record({
      id: 'PG-O10',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Partial unique index idx_order_rework_one_active blocks second concurrent APPROVED request',
      connections: 1,
      operation: 'Second create_order_rework_request for order with active request',
      expected: 'Rejection: already has an active approved rework request',
      actual: o10Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: o10Blocked ? 'PASS' : 'FAIL',
    });

    // PG-O11: Cancellation of APPROVED request works (CANCELLED)
    let o11Cancelled = false;
    try {
      const resCancel = await oClient.query(`
        SELECT cancel_order_rework_request($1, 'Customer decided not to rework')
      `, [reworkO2Id]);
      o11Cancelled = resCancel.rows[0].cancel_order_rework_request.status === 'CANCELLED';
    } catch (err) {
      console.error('PG-O11 error:', err.message);
    }
    record({
      id: 'PG-O11',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Cancellation of APPROVED rework request succeeds and transitions to CANCELLED',
      connections: 1,
      operation: 'cancel_order_rework_request(reworkO2Id)',
      expected: 'Rework request status = CANCELLED',
      actual: o11Cancelled ? 'CANCELLED' : 'FAIL',
      status: o11Cancelled ? 'PASS' : 'FAIL',
    });

    // PG-O12: Outbound with CANCELLED request rejected
    let o12Blocked = false;
    try {
      await oClient.query(`
        SELECT create_manifest_with_orders('TRX-O12', $1, $2, $3, 'B 2222 O12', 'Outbound with cancelled auth', ARRAY[$4]::uuid[])
      `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO2]);
    } catch (err) {
      o12Blocked = err.message.includes('requires an active approved rework request');
    }
    record({
      id: 'PG-O12',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Outbound dispatch with CANCELLED rework authorization rejected',
      connections: 1,
      operation: 'create_manifest_with_orders after rework cancellation',
      expected: 'Rejection: requires an active approved rework request',
      actual: o12Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: o12Blocked ? 'PASS' : 'FAIL',
    });

    // PG-O13: Concurrent dispatch on same rework authorization (Dual Connections)
    await oClient.query(`
      SELECT create_order_rework_request($1, 'OUTLET_QC_REJECT', 'QC failed at outlet, returning to workshop')
    `, [orderO2]);

    const oConn1 = await pool.connect();
    const oConn2 = await pool.connect();
    await oConn1.query('SET ROLE authenticated');
    await oConn1.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [USER_A_OWNER]);
    await oConn1.query("SELECT set_config('request.jwt.claim', $1, false)", [JSON.stringify({ app_metadata: { organization_id: ORG_A } })]);

    await oConn2.query('SET ROLE authenticated');
    await oConn2.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [USER_A_OWNER]);
    await oConn2.query("SELECT set_config('request.jwt.claim', $1, false)", [JSON.stringify({ app_metadata: { organization_id: ORG_A } })]);

    const p1 = oConn1.query(`
      SELECT create_manifest_with_orders('TRX-O13-C1', $1, $2, $3, 'B 1313 C1', 'Concurrent Dispatch 1', ARRAY[$4]::uuid[])
    `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO2]);

    const p2 = oConn2.query(`
      SELECT create_manifest_with_orders('TRX-O13-C2', $1, $2, $3, 'B 1313 C2', 'Concurrent Dispatch 2', ARRAY[$4]::uuid[])
    `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO2]);

    const resultsConcurrent = await Promise.allSettled([p1, p2]);
    oConn1.release();
    oConn2.release();

    const succeededCount = resultsConcurrent.filter(r => r.status === 'fulfilled').length;
    const failedCount = resultsConcurrent.filter(r => r.status === 'rejected').length;

    record({
      id: 'PG-O13',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Dual concurrent dispatch on same rework authorization: exactly one succeeds, one rejected',
      connections: 2,
      operation: 'Parallel create_manifest_with_orders on 2 connections',
      expected: '1 fulfilled, 1 rejected',
      actual: `fulfilled: ${succeededCount}, rejected: ${failedCount}`,
      status: succeededCount === 1 && failedCount === 1 ? 'PASS' : 'FAIL',
    });

    // PG-O14: Return with RECEIVED_DAMAGED item status successfully accepted into outlet
    const resO_dmg = await client.query(`
      INSERT INTO orders (
        organization_id, branch_id, production_branch_id, customer_id, order_number, tracking_token,
        status, operating_mode, subtotal, final_amount, paid_amount, payment_status, promised_ready_at, created_by
      ) VALUES ($1, $2, $3, $4, 'ORD-DMG-001', 'trk-dmg-001', 'RECEIVED', 'SIMPLE', 60000, 60000, 60000, 'PAID', NOW() + INTERVAL '24 hours', $5)
      RETURNING id
    `, [ORG_A, BRANCH_A1, CENTRAL_A, CUST_A, USER_A_A1]);
    const orderO_dmg = resO_dmg.rows[0].id;

    const resM_dmg = await oClient.query(`
      SELECT create_manifest_with_orders('TRX-O14-OUT', $1, $2, $3, 'B 1414 D', 'Outbound Dmg', ARRAY[$4]::uuid[])
    `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO_dmg]);
    await client.query(`UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1`, [resM_dmg.rows[0].create_manifest_with_orders.manifest_id]);
    await client.query(`UPDATE transit_manifests SET status = 'IN_TRANSIT', dispatched_at = NOW() WHERE id = $1`, [resM_dmg.rows[0].create_manifest_with_orders.manifest_id]);
    await oClient.query(`
      SELECT receive_manifest_with_discrepancy(
        $1,
        jsonb_build_array(jsonb_build_object('order_id', $2::text, 'status', 'RECEIVED_OK', 'notes', 'ok')),
        'Tiba'
      )
    `, [resM_dmg.rows[0].create_manifest_with_orders.manifest_id, orderO_dmg]);

    const resRetDmg = await oClient.query(`
      SELECT create_manifest_with_orders('TRX-O14-RET', $1, $2, $3, 'B 1414 DR', 'Return Dmg', ARRAY[$4]::uuid[])
    `, [CENTRAL_A, BRANCH_A1, USER_A_DRIVER, orderO_dmg]);
    const manDmgRetId = resRetDmg.rows[0].create_manifest_with_orders.manifest_id;
    await client.query(`UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1`, [manDmgRetId]);
    await client.query(`UPDATE transit_manifests SET status = 'IN_TRANSIT', dispatched_at = NOW() WHERE id = $1`, [manDmgRetId]);

    let o14DmgReceived = false;
    try {
      await oClient.query(`
        SELECT receive_manifest_with_discrepancy(
          $1,
          jsonb_build_array(jsonb_build_object('order_id', $2::text, 'status', 'DAMAGED', 'notes', 'Button broken during wash')),
          'Received with damage discrepancy at outlet'
        )
      `, [manDmgRetId, orderO_dmg]);
      o14DmgReceived = true;
    } catch (err) {
      console.error('PG-O14 error:', err.message);
    }
    record({
      id: 'PG-O14',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Return with DAMAGED item discrepancy successfully accepted at origin outlet',
      connections: 1,
      operation: 'receive_manifest_with_discrepancy with DAMAGED status',
      expected: 'Receipt accepted and manifest status = RECEIVED',
      actual: o14DmgReceived ? 'RECEIVED' : 'FAIL',
      status: o14DmgReceived ? 'PASS' : 'FAIL',
    });

    // PG-O15: Return with RECEIVED_MISSING item status rejected / blocked from cycle completion
    const resO_mis = await client.query(`
      INSERT INTO orders (
        organization_id, branch_id, production_branch_id, customer_id, order_number, tracking_token,
        status, operating_mode, subtotal, final_amount, paid_amount, payment_status, promised_ready_at, created_by
      ) VALUES ($1, $2, $3, $4, 'ORD-MIS-001', 'trk-mis-001', 'RECEIVED', 'SIMPLE', 70000, 70000, 70000, 'PAID', NOW() + INTERVAL '24 hours', $5)
      RETURNING id
    `, [ORG_A, BRANCH_A1, CENTRAL_A, CUST_A, USER_A_A1]);
    const orderO_mis = resO_mis.rows[0].id;

    const resM_mis = await oClient.query(`
      SELECT create_manifest_with_orders('TRX-O15-OUT', $1, $2, $3, 'B 1515 M', 'Outbound Mis', ARRAY[$4]::uuid[])
    `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO_mis]);
    await client.query(`UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1`, [resM_mis.rows[0].create_manifest_with_orders.manifest_id]);
    await client.query(`UPDATE transit_manifests SET status = 'IN_TRANSIT', dispatched_at = NOW() WHERE id = $1`, [resM_mis.rows[0].create_manifest_with_orders.manifest_id]);
    await oClient.query(`
      SELECT receive_manifest_with_discrepancy(
        $1,
        jsonb_build_array(jsonb_build_object('order_id', $2::text, 'status', 'MISSING', 'notes', 'Item not in truck')),
        'Item missing'
      )
    `, [resM_mis.rows[0].create_manifest_with_orders.manifest_id, orderO_mis]);

    let o15Blocked = false;
    try {
      await oClient.query(`
        SELECT create_manifest_with_orders('TRX-O15-RET', $1, $2, $3, 'B 1515 MR', 'Return Missing', ARRAY[$4]::uuid[])
      `, [CENTRAL_A, BRANCH_A1, USER_A_DRIVER, orderO_mis]);
    } catch (err) {
      o15Blocked = err.message.includes('Return route violation') || err.message.includes('MISSING');
    }
    record({
      id: 'PG-O15',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Return dispatch for order marked MISSING in outbound transit rejected',
      connections: 1,
      operation: 'create_manifest_with_orders for MISSING item',
      expected: 'Rejection: Order marked MISSING cannot be returned',
      actual: o15Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: o15Blocked ? 'PASS' : 'FAIL',
    });

    // PG-O16: Return with WRONG_BRANCH rejected as normal return
    const resO_wb = await client.query(`
      INSERT INTO orders (
        organization_id, branch_id, production_branch_id, customer_id, order_number, tracking_token,
        status, operating_mode, subtotal, final_amount, paid_amount, payment_status, promised_ready_at, created_by
      ) VALUES ($1, $2, $3, $4, 'ORD-WB-001', 'trk-wb-001', 'RECEIVED', 'SIMPLE', 75000, 75000, 75000, 'PAID', NOW() + INTERVAL '24 hours', $5)
      RETURNING id
    `, [ORG_A, BRANCH_A1, CENTRAL_A, CUST_A, USER_A_A1]);
    const orderO_wb = resO_wb.rows[0].id;

    const resM_wb = await oClient.query(`
      SELECT create_manifest_with_orders('TRX-O16-OUT', $1, $2, $3, 'B 1616 WB', 'Outbound WB', ARRAY[$4]::uuid[])
    `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO_wb]);
    await client.query(`UPDATE transit_manifests SET status = 'READY_TO_DISPATCH' WHERE id = $1`, [resM_wb.rows[0].create_manifest_with_orders.manifest_id]);
    await client.query(`UPDATE transit_manifests SET status = 'IN_TRANSIT', dispatched_at = NOW() WHERE id = $1`, [resM_wb.rows[0].create_manifest_with_orders.manifest_id]);
    await oClient.query(`
      SELECT receive_manifest_with_discrepancy(
        $1,
        jsonb_build_array(jsonb_build_object('order_id', $2::text, 'status', 'WRONG_BRANCH', 'notes', 'Delivered to wrong facility')),
        'Wrong branch receipt'
      )
    `, [resM_wb.rows[0].create_manifest_with_orders.manifest_id, orderO_wb]);

    let o16Blocked = false;
    try {
      await oClient.query(`
        SELECT create_manifest_with_orders('TRX-O16-RET', $1, $2, $3, 'B 1616 WBR', 'Return WB', ARRAY[$4]::uuid[])
      `, [CENTRAL_A, BRANCH_A1, USER_A_DRIVER, orderO_wb]);
    } catch (err) {
      o16Blocked = err.message.includes('Return route violation') || err.message.includes('WRONG_BRANCH');
    }
    record({
      id: 'PG-O16',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Normal return dispatch for order marked WRONG_BRANCH rejected',
      connections: 1,
      operation: 'create_manifest_with_orders for WRONG_BRANCH item',
      expected: 'Rejection: Order marked WRONG_BRANCH cannot be returned as normal return',
      actual: o16Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: o16Blocked ? 'PASS' : 'FAIL',
    });

    // PG-O17: Cycle 3 Outbound with new APPROVED rework request succeeds and consumes token
    const resRwO1_2 = await oClient.query(`
      SELECT create_order_rework_request($1, 'OTHER', 'Cycle 3 rework authorization')
    `, [orderO1]);
    const reworkO1_2Id = resRwO1_2.rows[0].create_order_rework_request.rework_request_id;

    const resM_O17 = await oClient.query(`
      SELECT create_manifest_with_orders('TRX-O17', $1, $2, $3, 'B 1717 O17', 'Cycle 3 Outbound', ARRAY[$4]::uuid[])
    `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO1]);
    const manO17Id = resM_O17.rows[0].create_manifest_with_orders.manifest_id;

    const rwChk17 = await client.query(`
      SELECT status, consumed_manifest_id FROM order_rework_requests WHERE id = $1
    `, [reworkO1_2Id]);
    const isConsumed17 = rwChk17.rows[0] && rwChk17.rows[0].status === 'CONSUMED' && rwChk17.rows[0].consumed_manifest_id === manO17Id;

    record({
      id: 'PG-O17',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Cycle 3 Outbound with new APPROVED rework authorization succeeds and consumes token',
      connections: 1,
      operation: 'create_manifest_with_orders on Cycle 3 with fresh authorization',
      expected: 'Manifest created and second rework request status = CONSUMED',
      actual: manO17Id && isConsumed17 ? 'CONSUMED' : 'FAIL',
      status: manO17Id && isConsumed17 ? 'PASS' : 'FAIL',
    });

    // PG-O18: Rework request creation for order not at origin branch rejected
    let o18Blocked = false;
    try {
      await oClient.query(`
        SELECT create_order_rework_request($1, 'CUSTOMER_COMPLAINT', 'Order is still at workshop')
      `, [orderO_wrong]);
    } catch (err) {
      o18Blocked = err.message.includes('Physical custody violation') || err.message.includes('not physically at origin outlet');
    }
    record({
      id: 'PG-O18',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Rework request creation for order physically at workshop rejected',
      connections: 1,
      operation: 'create_order_rework_request for order currently at workshop',
      expected: 'Rejection: Physical custody violation (not physically at origin outlet)',
      actual: o18Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: o18Blocked ? 'PASS' : 'FAIL',
    });

    // PG-O19: Rework request creation for order in active manifest rejected
    let o19Blocked = false;
    try {
      await oClient.query(`
        SELECT create_order_rework_request($1, 'CUSTOMER_COMPLAINT', 'Order in active manifest')
      `, [orderO1]);
    } catch (err) {
      o19Blocked = err.message.includes('sedang berada dalam manifest aktif');
    }
    record({
      id: 'PG-O19',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Rework request creation for order assigned to active manifest rejected',
      connections: 1,
      operation: 'create_order_rework_request for order in DRAFT manifest',
      expected: 'Rejection: Order is in active manifest',
      actual: o19Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: o19Blocked ? 'PASS' : 'FAIL',
    });

    // PG-O20: Direct update of order_rework_requests.status from CONSUMED back to APPROVED blocked
    let o20Blocked = false;
    try {
      await client.query(`
        UPDATE order_rework_requests SET status = 'APPROVED' WHERE id = $1
      `, [reworkO1Id]);
    } catch (err) {
      o20Blocked = err.message.includes('Illegal status transition');
    }
    record({
      id: 'PG-O20',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Direct update of order_rework_requests.status from CONSUMED to APPROVED blocked',
      connections: 1,
      operation: 'UPDATE order_rework_requests SET status = APPROVED WHERE id = consumed_id',
      expected: 'Rejection with status transition trigger error',
      actual: o20Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: o20Blocked ? 'PASS' : 'FAIL',
    });

    // PG-O21: Cross-tenant rework authorization rejected
    const resOB = await client.query(`
      INSERT INTO orders (
        organization_id, branch_id, production_branch_id, customer_id, order_number, tracking_token,
        status, operating_mode, subtotal, final_amount, paid_amount, payment_status, promised_ready_at, created_by
      ) VALUES ($1, $2, $2, $3, 'ORD-TB-001', 'trk-tb-001', 'RECEIVED', 'SIMPLE', 30000, 30000, 30000, 'PAID', NOW() + INTERVAL '24 hours', $4)
      RETURNING id
    `, [ORG_B, BRANCH_B1, CUST_B, USER_B_USER]);
    const orderB1 = resOB.rows[0].id;

    let o21Blocked = false;
    try {
      await oClient.query(`
        SELECT create_order_rework_request($1, 'CUSTOMER_COMPLAINT', 'Cross-tenant attack')
      `, [orderB1]);
    } catch (err) {
      o21Blocked = err.message.includes('Cross-tenant violation') || err.message.includes('tidak ditemukan') || err.message.includes('Access denied');
    }
    record({
      id: 'PG-O21',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Cross-tenant rework authorization creation strictly rejected',
      connections: 1,
      operation: 'create_order_rework_request on foreign tenant order',
      expected: 'Rejection: Cross-tenant violation or Access denied',
      actual: o21Blocked ? 'REJECTED' : 'NOT BLOCKED',
      status: o21Blocked ? 'PASS' : 'FAIL',
    });

    // PG-O22: Invariant Check: orders.branch_id, production_branch_id, status unaltered by rework lifecycles
    const postRwOrder1 = await client.query(`
      SELECT branch_id, production_branch_id, status FROM orders WHERE id = $1
    `, [orderO1]);
    const ordRw1 = postRwOrder1.rows[0];
    const rw1BranchIntact = ordRw1.branch_id === BRANCH_A1;
    const rw1ProdIntact = ordRw1.production_branch_id === CENTRAL_A;
    const rw1StatusIntact = ordRw1.status === 'RECEIVED';

    record({
      id: 'PG-O22',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Multi-cycle invariant: orders.branch_id, production_branch_id, and status remain unaltered',
      connections: 1,
      operation: 'Verification of orders table after 3 cycles and multiple rework authorizations',
      expected: 'branch_id = A1, production_branch_id = CENTRAL_A, status = RECEIVED (unaltered)',
      actual: `branch_id: ${ordRw1.branch_id}, prod_id: ${ordRw1.production_branch_id}, status: ${ordRw1.status}`,
      status: rw1BranchIntact && rw1ProdIntact && rw1StatusIntact ? 'PASS' : 'FAIL',
    });

    // PG-O23: Failure Injection: atomic rollback on batch manifest creation containing one invalid order
    let o23RolledBack = false;
    const prevDraftCount = await client.query(`SELECT COUNT(*)::int as cnt FROM transit_manifests WHERE manifest_number = 'TRX-O23-FAIL'`);
    try {
      await oClient.query(`
        SELECT create_manifest_with_orders('TRX-O23-FAIL', $1, $2, $3, 'B 2323 F', 'Failure Injection Test', ARRAY[$4, $5]::uuid[])
      `, [BRANCH_A1, CENTRAL_A, USER_A_DRIVER, orderO_wrong, orderO_mis]);
    } catch (err) {
      o23RolledBack = true;
    }
    const postDraftCount = await client.query(`SELECT COUNT(*)::int as cnt FROM transit_manifests WHERE manifest_number = 'TRX-O23-FAIL'`);
    const noPhantomManifest = prevDraftCount.rows[0].cnt === postDraftCount.rows[0].cnt;

    record({
      id: 'PG-O23',
      group: 'Group O: Multi-Cycle & Rework Gate',
      scenario: 'Failure injection: atomic rollback on batch manifest creation with invalid order',
      connections: 1,
      operation: 'create_manifest_with_orders with mixed valid/invalid orders',
      expected: 'Transaction rolls back completely with no phantom manifest created',
      actual: o23RolledBack && noPhantomManifest ? 'ATOMIC_ROLLBACK' : 'PARTIAL_WRITE_DETECTED',
      status: o23RolledBack && noPhantomManifest ? 'PASS' : 'FAIL',
    });

    await oClient.query('RESET ROLE');
    oClient.release();

  } catch (err) {
    console.error('CRITICAL UNEXPECTED ERROR IN TEST SUITE:', err);
  } finally {
    client.release();
    await pool.end();
  }

  // --------------------------------------------------------------------------
  // SUMMARY
  // --------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log('📊 TEST EXECUTION SUMMARY:');
  console.log('================================================================');
  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  console.log(`TOTAL TESTS: ${results.length}`);
  console.log(`PASSED:      ${passCount}`);
  console.log(`FAILED:      ${failCount}`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTest();
