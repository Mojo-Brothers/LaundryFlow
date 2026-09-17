import { describe, it, expect } from 'vitest';
import { formatIndonesianPhone, WhatsAppLauncherService } from '../core/services/notification';
import { Order, Customer } from '../core/types/database';

describe('WhatsApp Notification Service', () => {
  it('should format Indonesian phone numbers properly', () => {
    expect(formatIndonesianPhone('081234567890')).toBe('6281234567890');
    expect(formatIndonesianPhone('+62 812-3456-7890')).toBe('6281234567890');
    expect(formatIndonesianPhone('6285712345678')).toBe('6285712345678');
  });

  it('should construct high-fidelity WhatsApp ready message with tracking link', () => {
    const service = new WhatsAppLauncherService('https://app.laundryflow.id');
    const mockCustomer: Customer = {
      id: 'cust-1',
      organization_id: 'org-1',
      name: 'Ibu Siti',
      phone: '081234567890',
      membership_tier: 'VIP',
      created_at: '',
      updated_at: '',
    };

    const mockOrder: Order = {
      id: 'order-1',
      organization_id: 'org-1',
      branch_id: 'b-1',
      production_branch_id: 'b-1',
      customer_id: 'cust-1',
      order_number: 'BKS-2609-0042',
      tracking_token: 'trk_token_xyz99',
      status: 'READY',
      operating_mode: 'SIMPLE',
      subtotal: 50000,
      discount_amount: 0,
      delivery_fee: 0,
      final_amount: 50000,
      paid_amount: 50000,
      remaining_amount: 0,
      payment_status: 'PAID',
      promised_ready_at: new Date().toISOString(),
      created_by: 'user-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const msg = service.buildOrderReadyMessage(mockOrder, mockCustomer, 'Outlet Bekasi Timur');
    expect(msg).toContain('Ibu Siti');
    expect(msg).toContain('BKS-2609-0042');
    expect(msg).toContain('SELESAI & SIAP DIAMBIL');
    expect(msg).toContain('https://app.laundryflow.id/track/trk_token_xyz99');
  });
});
