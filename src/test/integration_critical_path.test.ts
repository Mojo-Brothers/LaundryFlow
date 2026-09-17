import { describe, it, expect, beforeEach } from 'vitest';
import { repository } from '../core/services/repository';
import { calculateItemPrice } from '../core/services/pricing';
import { notificationService } from '../core/services/notification';
import { Service } from '../core/types/database';

describe('LaundryFlow Acceptance Test — Critical Path', () => {
  beforeEach(() => {
    repository.resetSandbox();
  });

  it('executes full critical path: fast checkout kiloan, price snapshot, shift update, and tracking', async () => {
    // 1. Select Branch & User
    const branches = await repository.getBranches();
    const outletBekasi = branches[0];
    expect(outletBekasi.code).toBe('BKS-01');

    const users = await repository.getUsers();
    const cashier = users.find((u) => u.role === 'CASHIER');
    expect(cashier).toBeDefined();

    // 2. Open Cashier Shift with Initial Cash
    const shift = await repository.openShift({
      organization_id: outletBekasi.organization_id,
      branch_id: outletBekasi.id,
      cashier_id: cashier!.id,
      opening_cash: 150000,
      expected_cash: 150000,
      status: 'OPEN',
      notes: 'Morning shift',
    });
    expect(shift.status).toBe('OPEN');
    expect(shift.expected_cash).toBe(150000);

    // 3. Find or Create Customer
    const newCustomer = await repository.createCustomer({
      organization_id: outletBekasi.organization_id,
      name: 'Ibu Ratna Dewi',
      phone: '081298765432',
      whatsapp: '081298765432',
      address: 'Jl. Ahmad Yani No. 12, Bekasi',
      membership_tier: 'VIP',
    });
    expect(newCustomer.id).toBeDefined();
    expect(newCustomer.phone).toBe('081298765432');

    // 4. Input Weight & Select Kiloan Service
    const services = await repository.getServices();
    const kiloanReguler: Service = services.find((s) => s.unit === 'KG')!;
    expect(kiloanReguler).toBeDefined();

    // Actual weight is 3.7 kg -> rounded with ROUND_HALF_UP_0_5 to 4.0 kg
    const calc = calculateItemPrice({
      service: kiloanReguler,
      actualQuantityOrWeight: 3.7,
      customDiscountAmount: 0,
    });
    expect(calc.actualQuantityOrWeight).toBe(3.7);
    expect(calc.billableQuantityOrWeight).toBe(4.0);
    expect(calc.subtotal).toBe(4.0 * kiloanReguler.base_price);

    // 5. Create Order & Pay Cash Immediately
    const order = await repository.createOrder(
      {
        organization_id: outletBekasi.organization_id,
        branch_id: outletBekasi.id,
        production_branch_id: outletBekasi.id,
        customer_id: newCustomer.id,
        status: 'RECEIVED',
        operating_mode: 'SIMPLE',
        subtotal: calc.subtotal,
        discount_amount: 0,
        delivery_fee: 0,
        final_amount: calc.finalAmount,
        paid_amount: calc.finalAmount,
        remaining_amount: 0,
        payment_status: 'PAID',
        promised_ready_at: new Date(Date.now() + 48 * 3600000).toISOString(),
        created_by: cashier!.id,
        notes: 'Pewangi Sakura',
      },
      [
        {
          service_id: kiloanReguler.id,
          item_type: 'KILOAN',
          service_name_snap: kiloanReguler.name,
          unit_price_snap: kiloanReguler.base_price,
          quantity_or_weight: calc.actualQuantityOrWeight,
          billable_weight: calc.billableQuantityOrWeight,
          subtotal: calc.subtotal,
          notes: 'Pewangi Sakura',
        },
      ],
      {
        method: 'CASH',
        amount: calc.finalAmount,
      }
    );

    expect(order.order_number).toMatch(/^BKS-\d{4}-\d{4}$/);
    expect(order.tracking_token).toContain('trk_');
    expect(order.payment_status).toBe('PAID');
    expect(order.paid_amount).toBe(calc.finalAmount);

    // 6. Verify Shift Expected Cash increased by the Cash payment
    const activeShift = await repository.getActiveShift(outletBekasi.id);
    expect(activeShift?.expected_cash).toBe(150000 + calc.finalAmount);

    // 7. Verify WhatsApp Message Construction
    const waMessage = notificationService.buildNewOrderMessage(order, newCustomer, outletBekasi.name);
    expect(waMessage).toContain('Ibu Ratna Dewi');
    expect(waMessage).toContain(order.order_number);
    expect(waMessage).toContain(order.tracking_token);

    // 8. Progress Order Status: RECEIVED -> WASHING -> READY
    const washingOrder = await repository.updateOrderStatus(order.id, 'WASHING', cashier!.id);
    expect(washingOrder.status).toBe('WASHING');

    const readyOrder = await repository.updateOrderStatus(order.id, 'READY', cashier!.id);
    expect(readyOrder.status).toBe('READY');

    // 9. Verify Public Customer Tracking by Token (without login)
    const trackedOrder = await repository.getOrderByTrackingToken(order.tracking_token);
    expect(trackedOrder).toBeDefined();
    expect(trackedOrder?.id).toBe(order.id);
    expect(trackedOrder?.status).toBe('READY');
    expect(trackedOrder?.final_amount).toBe(calc.finalAmount);

    // 10. Complete Pickup
    const completedOrder = await repository.updateOrderStatus(order.id, 'COMPLETED', cashier!.id);
    expect(completedOrder.status).toBe('COMPLETED');
  });
});
