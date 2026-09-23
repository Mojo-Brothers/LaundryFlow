// ============================================================================
// Production Repository Layer (Supabase RPC Adapter & Sandbox Provider)
// Step 4C.4A Application Foundation
// Boundary: UI -> Application Service -> Production Repository -> Supabase RPC
// ============================================================================

import {
  ProductionJob,
  ProductionWorkItem,
  ProductionStageLog,
  ProductionStage,
  SplitReason,
  Order,
  WorkshopProductionReadModel,
  WorkshopProductionWorkItem,
  WorkshopProductionJobSummary,
} from '../types/database';
import { supabase, isLiveSupabaseConfigured } from '../supabase/client';
import { RepositoryError, normalizeRepositoryError, repository } from './repository';

export interface IProductionRepository {
  startProductionJob(orderId: string): Promise<ProductionJob>;
  advanceWorkItemStage(workItemId: string, notes?: string): Promise<void>;
  splitWorkItem(
    workItemId: string,
    splitQuantities: number[],
    splitReason: SplitReason,
    notes?: string
  ): Promise<void>;
  qcEvaluateWorkItem(
    workItemId: string,
    passed: boolean,
    remediationStage?: ProductionStage,
    notes?: string
  ): Promise<void>;
  completeProductionJob(jobId: string): Promise<void>;
  completeSimpleProductionJob(orderId: string): Promise<void>;
  getProductionJobWithItems(orderId: string): Promise<ProductionJob | null>;
  getProductionJobById(jobId: string): Promise<ProductionJob | null>;
  getWorkshopProduction(workshopBranchId: string): Promise<WorkshopProductionReadModel>;
  resetSandbox?(): void;
}

interface SandboxProductionStore {
  jobs: ProductionJob[];
  workItems: ProductionWorkItem[];
  stageLogs: ProductionStageLog[];
}

export class ProductionRepository implements IProductionRepository {
  private sandbox: SandboxProductionStore = {
    jobs: [],
    workItems: [],
    stageLogs: [],
  };

  /**
   * Resets sandbox state for testing and demo isolation
   */
  resetSandbox(): void {
    this.sandbox = {
      jobs: [],
      workItems: [],
      stageLogs: [],
    };
  }

  // ==========================================================================
  // 1. startProductionJob
  // SQL RPC: start_production_job(p_order_id UUID)
  // Idempotent: returns existing active job if already created for fulfillment cycle
  // ==========================================================================
  async startProductionJob(orderId: string): Promise<ProductionJob> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase.rpc('start_production_job', {
        p_order_id: orderId,
      });

      if (error) throw normalizeRepositoryError(error);

      const jobId = data?.job_id;
      if (!jobId) {
        throw new RepositoryError(
          'DATABASE_ERROR',
          'Gagal memulai production job: ID pekerjaan tidak diterima dari server.'
        );
      }

      const job = await this.getProductionJobById(jobId);
      if (!job) {
        throw new RepositoryError(
          'NOT_FOUND',
          `Production job ${jobId} berhasil diproses namun tidak dapat dimuat kembali.`
        );
      }
      return job;
    }

    // --- Sandbox Simulation ---
    const orders = await repository.getOrders();
    const order = orders.find((o: Order) => o.id === orderId);
    if (!order) {
      throw new RepositoryError('NOT_FOUND', `Order ${orderId} tidak ditemukan.`);
    }

    // Active rework cycle check simulation (parity with start_production_job RPC)
    const reworkRequests = await repository.getOrderReworkRequests(orderId);
    const activeRework = reworkRequests
      .filter((r) => r.status === 'CONSUMED')
      .sort(
        (a, b) =>
          new Date(b.consumed_at || b.created_at).getTime() -
          new Date(a.consumed_at || a.created_at).getTime()
      )[0];
    const reworkId = activeRework?.id || null;

    // Idempotency: check if job already exists for this fulfillment cycle
    let existingJob: ProductionJob | undefined;
    if (reworkId) {
      existingJob = this.sandbox.jobs.find((j) => j.rework_request_id === reworkId);
    } else {
      existingJob = this.sandbox.jobs.find(
        (j) => j.order_id === orderId && (!j.rework_request_id || j.rework_request_id === null)
      );
    }

    if (existingJob) {
      return (await this.getProductionJobById(existingJob.id))!;
    }

    // Central production physical custody check simulation
    if (order.branch_id !== order.production_branch_id) {
      const manifests = await repository.listTransitManifests({ branchId: order.production_branch_id });
      const hasReceivedCustody = manifests.some(
        (m) =>
          m.status === 'RECEIVED' &&
          m.items?.some((i) => i.order_id === orderId && i.received_status === 'RECEIVED_OK')
      );

      if (!hasReceivedCustody) {
        throw new RepositoryError(
          'VALIDATION_ERROR',
          `Order ${orderId} belum memiliki bukti serah-terima fisik (RECEIVED_OK) di workshop central.`
        );
      }
    }

    const jobId = `job-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const newJob: ProductionJob = {
      id: jobId,
      organization_id: order.organization_id,
      order_id: orderId,
      branch_id: order.production_branch_id,
      rework_request_id: reworkId,
      status: 'IN_PROGRESS',
      notes: null,
      created_by: 'system',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      order,
    };
    this.sandbox.jobs.push(newJob);

    // Snapshot order items into production work items
    const orderItems = order.items || [];
    const services = await repository.getServices();
    let seq = 0;
    for (const oi of orderItems) {
      seq++;
      const workItemId = `pwi-${Date.now()}-${seq}-${Math.floor(Math.random() * 10000)}`;
      const defaultStages: ProductionStage[] = ['WASHING', 'DRYING', 'IRONING', 'PACKED'];
      const svc = services.find((s) => s.id === oi.service_id);
      const stages = svc?.standard_stages || defaultStages;

      const pwi: ProductionWorkItem = {
        id: workItemId,
        job_id: jobId,
        organization_id: order.organization_id,
        order_item_id: oi.id,
        service_id: oi.service_id,
        parent_item_id: null,
        item_code: `${order.order_number}-ITM-${String(seq).padStart(2, '0')}`,
        service_name_snap: oi.service_name_snap || svc?.name || 'Laundry Service',
        unit: svc?.unit || (oi.item_type === 'KILOAN' ? 'KG' : 'PCS'),
        quantity: oi.quantity_or_weight,
        service_stages: stages,
        current_stage: stages[0],
        stage_index: 1,
        status: 'IN_PROGRESS',
        split_reason: null,
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.sandbox.workItems.push(pwi);

      // Initial START stage log
      this.sandbox.stageLogs.push({
        id: `log-${Date.now()}-${seq}`,
        work_item_id: workItemId,
        organization_id: order.organization_id,
        from_stage: null,
        to_stage: stages[0],
        transition_type: 'START',
        actor_id: 'system',
        notes: 'Production started at initial stage',
        created_at: new Date().toISOString(),
      });
    }

    return (await this.getProductionJobById(jobId))!;
  }

  // ==========================================================================
  // 2. advanceWorkItemStage
  // SQL RPC: advance_work_item_stage(p_work_item_id UUID, p_notes TEXT)
  // Advances item stage sequentially (k -> k+1) using 'ADVANCE'
  // ==========================================================================
  async advanceWorkItemStage(workItemId: string, notes?: string): Promise<void> {
    if (isLiveSupabaseConfigured && supabase) {
      const { error } = await supabase.rpc('advance_work_item_stage', {
        p_work_item_id: workItemId,
        p_notes: notes || null,
      });

      if (error) throw normalizeRepositoryError(error);
      return;
    }

    // --- Sandbox Simulation ---
    const item = this.sandbox.workItems.find((w) => w.id === workItemId);
    if (!item) {
      throw new RepositoryError('NOT_FOUND', `Work item ${workItemId} tidak ditemukan.`);
    }

    if (item.status !== 'IN_PROGRESS') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Work item ${workItemId} berstatus '${item.status}' dan tidak dapat dimajukan.`
      );
    }

    const nextIdx = item.stage_index + 1;
    if (nextIdx > item.service_stages.length) {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Work item ${workItemId} sudah berada di tahapan akhir '${item.current_stage}'.`
      );
    }

    const fromStage = item.current_stage;
    const nextStage = item.service_stages[nextIdx - 1];
    const isTerminal = nextIdx === item.service_stages.length && nextStage === 'PACKED';

    item.current_stage = nextStage;
    item.stage_index = nextIdx;
    item.status = isTerminal ? 'COMPLETED' : 'IN_PROGRESS';
    item.updated_at = new Date().toISOString();

    this.sandbox.stageLogs.push({
      id: `log-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      work_item_id: workItemId,
      organization_id: item.organization_id,
      from_stage: fromStage,
      to_stage: nextStage,
      transition_type: 'ADVANCE',
      actor_id: 'system',
      notes: notes || 'Tahapan produksi dilanjutkan',
      created_at: new Date().toISOString(),
    });
  }

  // ==========================================================================
  // 3. splitWorkItem
  // SQL RPC: split_work_item(p_work_item_id UUID, p_split_quantities NUMERIC[], p_split_reason split_reason_enum, p_notes TEXT)
  // Splits parent item (max depth 1) into child parts with exact quantity conservation
  // ==========================================================================
  async splitWorkItem(
    workItemId: string,
    splitQuantities: number[],
    splitReason: SplitReason,
    notes?: string
  ): Promise<void> {
    if (isLiveSupabaseConfigured && supabase) {
      const { error } = await supabase.rpc('split_work_item', {
        p_work_item_id: workItemId,
        p_split_quantities: splitQuantities,
        p_split_reason: splitReason,
        p_notes: notes || null,
      });

      if (error) throw normalizeRepositoryError(error);
      return;
    }

    // --- Sandbox Simulation ---
    const parent = this.sandbox.workItems.find((w) => w.id === workItemId);
    if (!parent) {
      throw new RepositoryError('NOT_FOUND', `Work item ${workItemId} tidak ditemukan.`);
    }

    if (parent.parent_item_id !== null) {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Split depth violation: Item ${workItemId} adalah child item dan tidak dapat di-split kembali.`
      );
    }

    if (parent.status !== 'IN_PROGRESS') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Work item ${workItemId} berstatus '${parent.status}' dan tidak dapat di-split.`
      );
    }

    if (!splitReason) {
      throw new RepositoryError(
        'VALIDATION_ERROR',
        'Split reason wajib diisi (CAPACITY_OVERFLOW, QC_DEFECT_ISOLATION, atau TREATMENT_SEGREGATION).'
      );
    }

    if (!splitQuantities || splitQuantities.length < 2) {
      throw new RepositoryError('VALIDATION_ERROR', 'Split memerlukan minimal 2 pecahan kuantitas.');
    }

    let sum = 0;
    for (const q of splitQuantities) {
      if (q <= 0) {
        throw new RepositoryError('VALIDATION_ERROR', `Kuantitas pecahan harus > 0 (diberikan: ${q}).`);
      }
      if ((parent.unit === 'PCS' || parent.unit === 'SET') && !Number.isInteger(q)) {
        throw new RepositoryError(
          'VALIDATION_ERROR',
          `Unit '${parent.unit}' membutuhkan kuantitas bulat utuh.`
        );
      }
      sum = Math.round((sum + q) * 100) / 100;
    }

    if (sum !== Math.round(parent.quantity * 100) / 100) {
      throw new RepositoryError(
        'VALIDATION_ERROR',
        `Quantity conservation violation: Total pecahan (${sum}) tidak sama dengan kuantitas parent (${parent.quantity}).`
      );
    }

    // Mark parent SPLIT
    parent.status = 'SPLIT';
    parent.updated_at = new Date().toISOString();

    // Log SPLIT on parent
    this.sandbox.stageLogs.push({
      id: `log-split-${Date.now()}`,
      work_item_id: parent.id,
      organization_id: parent.organization_id,
      from_stage: parent.current_stage,
      to_stage: parent.current_stage,
      transition_type: 'SPLIT',
      actor_id: 'system',
      notes: notes || `Item di-split menjadi ${splitQuantities.length} bagian. Alasan: ${splitReason}`,
      created_at: new Date().toISOString(),
    });

    // Create child items
    let idx = 0;
    for (const q of splitQuantities) {
      idx++;
      const childId = `pwi-child-${Date.now()}-${idx}`;
      const childItem: ProductionWorkItem = {
        id: childId,
        job_id: parent.job_id,
        organization_id: parent.organization_id,
        order_item_id: parent.order_item_id,
        service_id: parent.service_id,
        parent_item_id: parent.id,
        item_code: `${parent.item_code}-S${idx}`,
        service_name_snap: parent.service_name_snap,
        unit: parent.unit,
        quantity: q,
        service_stages: [...parent.service_stages],
        current_stage: parent.current_stage,
        stage_index: parent.stage_index,
        status: 'IN_PROGRESS',
        split_reason: splitReason,
        notes: `Split child from ${parent.item_code} (${splitReason})`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.sandbox.workItems.push(childItem);

      // Child initial START log
      this.sandbox.stageLogs.push({
        id: `log-child-start-${Date.now()}-${idx}`,
        work_item_id: childId,
        organization_id: parent.organization_id,
        from_stage: null,
        to_stage: parent.current_stage,
        transition_type: 'START',
        actor_id: 'system',
        notes: `Child work item created via split (${splitReason}) from ${parent.item_code}`,
        created_at: new Date().toISOString(),
      });
    }
  }

  // ==========================================================================
  // 4. qcEvaluateWorkItem
  // SQL RPC: qc_evaluate_work_item(p_work_item_id UUID, p_passed BOOLEAN, p_remediation_stage TEXT, p_notes TEXT)
  // Evaluates quality: PASS completes packed item; FAIL rewinds to valid non-PACKED stage
  // ==========================================================================
  async qcEvaluateWorkItem(
    workItemId: string,
    passed: boolean,
    remediationStage?: ProductionStage,
    notes?: string
  ): Promise<void> {
    if (isLiveSupabaseConfigured && supabase) {
      const { error } = await supabase.rpc('qc_evaluate_work_item', {
        p_work_item_id: workItemId,
        p_passed: passed,
        p_remediation_stage: remediationStage || null,
        p_notes: notes || null,
      });

      if (error) throw normalizeRepositoryError(error);
      return;
    }

    // --- Sandbox Simulation ---
    const item = this.sandbox.workItems.find((w) => w.id === workItemId);
    if (!item) {
      throw new RepositoryError('NOT_FOUND', `Work item ${workItemId} tidak ditemukan.`);
    }

    if (item.status !== 'IN_PROGRESS' && item.status !== 'COMPLETED') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Work item ${workItemId} berstatus '${item.status}' dan tidak dapat dievaluasi QC.`
      );
    }

    if (passed) {
      if (item.current_stage === 'PACKED') {
        item.status = 'COMPLETED';
      }
      item.updated_at = new Date().toISOString();

      this.sandbox.stageLogs.push({
        id: `log-qc-pass-${Date.now()}`,
        work_item_id: item.id,
        organization_id: item.organization_id,
        from_stage: item.current_stage,
        to_stage: item.current_stage,
        transition_type: 'QC_PASS',
        actor_id: 'system',
        notes: notes || 'Pemeriksaan kualitas lolos (QC Pass)',
        created_at: new Date().toISOString(),
      });
    } else {
      if (!remediationStage) {
        throw new RepositoryError('VALIDATION_ERROR', 'Tahapan remediasi wajib diisi saat QC gagal.');
      }
      if (remediationStage === 'PACKED') {
        throw new RepositoryError(
          'VALIDATION_ERROR',
          'Invalid remediation stage: QC_FAIL tidak dapat menargetkan tahapan akhir PACKED.'
        );
      }

      const remIdx = item.service_stages.indexOf(remediationStage);
      if (remIdx === -1) {
        throw new RepositoryError(
          'VALIDATION_ERROR',
          `Tahapan '${remediationStage}' bukan tahapan valid untuk layanan ini.`
        );
      }

      const fromStage = item.current_stage;
      item.current_stage = remediationStage;
      item.stage_index = remIdx + 1;
      item.status = 'IN_PROGRESS';
      item.updated_at = new Date().toISOString();

      this.sandbox.stageLogs.push({
        id: `log-qc-fail-${Date.now()}`,
        work_item_id: item.id,
        organization_id: item.organization_id,
        from_stage: fromStage,
        to_stage: remediationStage,
        transition_type: 'QC_FAIL',
        actor_id: 'system',
        notes: notes || `QC gagal. Remediasi diarahkan kembali ke ${remediationStage}`,
        created_at: new Date().toISOString(),
      });
    }
  }

  // ==========================================================================
  // 5. completeProductionJob
  // SQL RPC: complete_production_job(p_job_id UUID)
  // Asserts all active leaf work items are COMPLETED, completes job,
  // and projects orders.status = READY (if local) or remains WASHING (if central)
  // ==========================================================================
  async completeProductionJob(jobId: string): Promise<void> {
    if (isLiveSupabaseConfigured && supabase) {
      const { error } = await supabase.rpc('complete_production_job', {
        p_job_id: jobId,
      });

      if (error) throw normalizeRepositoryError(error);
      return;
    }

    // --- Sandbox Simulation ---
    const job = this.sandbox.jobs.find((j) => j.id === jobId);
    if (!job) {
      throw new RepositoryError('NOT_FOUND', `Production job ${jobId} tidak ditemukan.`);
    }

    if (job.status === 'COMPLETED') {
      return; // Idempotent success
    }

    if (job.status !== 'IN_PROGRESS') {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Production job ${jobId} berstatus '${job.status}' dan tidak dapat diselesaikan.`
      );
    }

    // Invariant: all active leaf work items must be COMPLETED
    const activeLeafItems = this.sandbox.workItems.filter(
      (w) => w.job_id === jobId && w.status !== 'SPLIT'
    );
    const incomplete = activeLeafItems.filter((w) => w.status !== 'COMPLETED');
    if (incomplete.length > 0) {
      throw new RepositoryError(
        'INVALID_STATE_TRANSITION',
        `Tidak dapat menyelesaikan job ${jobId}: masih terdapat ${incomplete.length} work item yang belum selesai.`
      );
    }

    job.status = 'COMPLETED';
    job.completed_at = new Date().toISOString();
    job.updated_at = new Date().toISOString();

    // Local vs Central Order Status Projection
    const orders = await repository.getOrders();
    const order = orders.find((o: Order) => o.id === job.order_id);
    if (order) {
      if (order.branch_id === order.production_branch_id) {
        order.status = 'READY';
      }
      // Central production: remains WASHING until return transit receipt at origin
    }
  }

  // ==========================================================================
  // 6. completeSimpleProductionJob
  // SQL RPC: complete_simple_production_job(p_order_id UUID)
  // Server-side procedural orchestrator: starts job if needed, advances items sequentially, completes job
  // ==========================================================================
  async completeSimpleProductionJob(orderId: string): Promise<void> {
    if (isLiveSupabaseConfigured && supabase) {
      const { error } = await supabase.rpc('complete_simple_production_job', {
        p_order_id: orderId,
      });

      if (error) throw normalizeRepositoryError(error);
      return;
    }

    // --- Sandbox Simulation ---
    const job = await this.startProductionJob(orderId);

    // Advance all active work items sequentially through remaining stages until PACKED
    const items = this.sandbox.workItems.filter(
      (w) => w.job_id === job.id && w.status === 'IN_PROGRESS'
    );

    for (const item of items) {
      while (item.stage_index < item.service_stages.length && item.status === 'IN_PROGRESS') {
        await this.advanceWorkItemStage(
          item.id,
          `Proses otomatis mode simpel ke tahapan ${item.service_stages[item.stage_index]}`
        );
      }
    }

    await this.completeProductionJob(job.id);
  }

  // ==========================================================================
  // 7. getProductionJobWithItems
  // Queries active or latest production job for order with work items and stage logs
  // ==========================================================================
  async getProductionJobWithItems(orderId: string): Promise<ProductionJob | null> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('production_jobs')
        .select(`
          *,
          work_items:production_work_items(
            *,
            stage_logs:production_stage_logs(*)
          ),
          order:orders(*),
          branch:branches(*),
          rework_request:order_rework_requests(*)
        `)
        .eq('order_id', orderId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw normalizeRepositoryError(error);
      if (!data) return null;
      return data as ProductionJob;
    }

    // --- Sandbox Simulation ---
    const job = this.sandbox.jobs
      .filter((j) => j.order_id === orderId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

    if (!job) return null;

    const workItems = this.sandbox.workItems
      .filter((w) => w.job_id === job.id)
      .map((w) => ({
        ...w,
        stage_logs: this.sandbox.stageLogs
          .filter((l) => l.work_item_id === w.id)
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
      }));

    return {
      ...job,
      work_items: workItems,
    };
  }

  // ==========================================================================
  // 8. getProductionJobById
  // Queries production job by primary key with work items and stage logs
  // ==========================================================================
  async getProductionJobById(jobId: string): Promise<ProductionJob | null> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('production_jobs')
        .select(`
          *,
          work_items:production_work_items(
            *,
            stage_logs:production_stage_logs(*)
          ),
          order:orders(*),
          branch:branches(*),
          rework_request:order_rework_requests(*)
        `)
        .eq('id', jobId)
        .maybeSingle();

      if (error) throw normalizeRepositoryError(error);
      if (!data) return null;
      return data as ProductionJob;
    }

    // --- Sandbox Simulation ---
    const job = this.sandbox.jobs.find((j) => j.id === jobId);
    if (!job) return null;

    const workItems = this.sandbox.workItems
      .filter((w) => w.job_id === job.id)
      .map((w) => ({
        ...w,
        stage_logs: this.sandbox.stageLogs
          .filter((l) => l.work_item_id === w.id)
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
      }));

    return {
      ...job,
      work_items: workItems,
    };
  }

  // ==========================================================================
  // 9. getWorkshopProduction
  // High-performance bulk read model for Workshop Kanban board
  // Returns all active jobs and active leaf work items for workshop branch
  // ==========================================================================
  async getWorkshopProduction(workshopBranchId: string): Promise<WorkshopProductionReadModel> {
    if (isLiveSupabaseConfigured && supabase) {
      const { data, error } = await supabase.rpc('get_workshop_production', {
        p_workshop_branch_id: workshopBranchId,
      });

      if (error) throw normalizeRepositoryError(error);
      return data as WorkshopProductionReadModel;
    }

    // --- Sandbox Simulation ---
    const cleanBranchId = (workshopBranchId || '').trim();
    if (!cleanBranchId) {
      throw new RepositoryError('VALIDATION_ERROR', 'ID workshop branch wajib diisi.');
    }

    const activeJobs = this.sandbox.jobs.filter(
      (j) => j.branch_id === cleanBranchId && j.status === 'IN_PROGRESS'
    );

    const orders = await repository.getOrders();
    const customers = await repository.getCustomers();
    const branches = await repository.getBranches();
    const currentBranch = branches.find((b) => b.id === cleanBranchId);

    const jobSummaries: WorkshopProductionJobSummary[] = [];
    const activeWorkItems: WorkshopProductionWorkItem[] = [];

    for (const job of activeJobs) {
      const order = orders.find((o: Order) => o.id === job.order_id);
      const customer = order
        ? customers.find((c) => c.id === order.customer_id && c.organization_id === order.organization_id)
        : undefined;
      const orderNumber = order?.order_number || job.order?.order_number || 'ORD-UNKNOWN';
      const customerName = customer?.name || 'Pelanggan';

      // Active leaf items: exclude SPLIT parents and CANCELLED items
      const items = this.sandbox.workItems.filter(
        (w) => w.job_id === job.id && w.status !== 'SPLIT' && w.status !== 'CANCELLED'
      );

      jobSummaries.push({
        id: job.id,
        order_id: job.order_id,
        order_number: orderNumber,
        customer_name: customerName,
        branch_id: job.branch_id,
        rework_request_id: job.rework_request_id || null,
        is_rework: Boolean(job.rework_request_id),
        status: job.status,
        created_at: job.created_at,
        work_items_count: items.length,
      });

      for (const item of items) {
        activeWorkItems.push({
          id: item.id,
          job_id: item.job_id,
          order_id: job.order_id,
          order_number: orderNumber,
          customer_name: customerName,
          order_item_id: item.order_item_id,
          service_id: item.service_id,
          item_code: item.item_code,
          service_name: item.service_name_snap,
          service_name_snap: item.service_name_snap,
          unit: item.unit,
          quantity: item.quantity,
          service_stages: item.service_stages,
          current_stage: item.current_stage,
          stage_index: item.stage_index,
          status: item.status,
          parent_item_id: item.parent_item_id || null,
          split_reason: item.split_reason || null,
          job_status: job.status,
          rework_request_id: job.rework_request_id || null,
          is_rework: Boolean(job.rework_request_id),
          job_created_at: job.created_at,
          workshop_branch_id: job.branch_id,
          workshop_branch_name: currentBranch?.name,
          notes: item.notes || null,
          created_at: item.created_at,
        });
      }
    }

    // Deterministic ordering parity: created_at ASC with stable id ASC tie-breaker
    jobSummaries.sort((a, b) => {
      const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.id.localeCompare(b.id);
    });

    activeWorkItems.sort((a, b) => {
      const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.id.localeCompare(b.id);
    });

    return {
      workshop_branch_id: cleanBranchId,
      workshop_branch_name: currentBranch?.name,
      jobs_count: jobSummaries.length,
      work_items_count: activeWorkItems.length,
      jobs: jobSummaries,
      work_items: activeWorkItems,
    };
  }
}

// Singleton repository instance
export const productionRepository = new ProductionRepository();
