// ============================================================================
// WhatsApp Launcher & Notification Service (Zero Cost & Anti-Banned Protocol)
// ============================================================================

import { Customer, Order, Payment } from '../types/database';
import { formatIDR } from '../utils/currency';

export interface NotificationService {
  buildNewOrderMessage(order: Order, customer: Customer, branchName: string): string;
  buildOrderReadyMessage(order: Order, customer: Customer, branchName: string): string;
  buildPaymentReceiptMessage(order: Order, customer: Customer, payment: Payment): string;
  launchWhatsApp(phone: string, message: string): void;
}

/**
 * Clean Indonesian phone number into international 62 format
 * Examples: 08123456789 -> 628123456789, +62812 -> 62812
 */
export function formatIndonesianPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.startsWith('0')) {
    return '62' + digits.slice(1);
  }
  if (digits.startsWith('62')) {
    return digits;
  }
  return '62' + digits;
}

export class WhatsAppLauncherService implements NotificationService {
  private baseUrl: string;

  constructor(appBaseUrl = window.location.origin) {
    this.baseUrl = appBaseUrl;
  }

  buildNewOrderMessage(order: Order, customer: Customer, branchName: string): string {
    const trackingUrl = `${this.baseUrl}/track/${order.tracking_token}`;
    const itemsSummary = order.items && order.items.length > 0
      ? order.items.map(i => `• ${i.service_name_snap} (${i.billable_weight} ${i.item_type === 'KILOAN' ? 'kg' : 'pcs'}) = ${formatIDR(i.subtotal)}`).join('\n')
      : `• Total Layanan: ${formatIDR(order.final_amount)}`;

    return [
      `Halo Kak *${customer.name}*,`,
      ``,
      `Terima kasih telah mempercayakan pakaian Anda di *${branchName}*.`,
      `Pesanan Anda telah kami terima dengan detail:`,
      ``,
      `📋 *No. Nota:* ${order.order_number}`,
      `📦 *Layanan:*`,
      itemsSummary,
      ``,
      `💰 *Total Tagihan:* ${formatIDR(order.final_amount)}`,
      `💳 *Status Bayar:* ${order.payment_status === 'PAID' ? 'LUNAS (Terima Kasih)' : `Belum Lunas (Sisa: ${formatIDR(order.remaining_amount)})`}`,
      `⏰ *Estimasi Selesai:* ${new Date(order.promised_ready_at).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} WIB`,
      ``,
      `🔍 *Lacak status cucian Anda secara realtime:*`,
      `${trackingUrl}`,
      ``,
      `Kami rawat pakaian Anda dengan sepenuh hati! ✨`
    ].join('\n');
  }

  buildOrderReadyMessage(order: Order, customer: Customer, branchName: string): string {
    const trackingUrl = `${this.baseUrl}/track/${order.tracking_token}`;
    return [
      `Halo Kak *${customer.name}*,`,
      ``,
      `Kabar gembira! Cucian Anda di *${branchName}* dengan nomor nota *${order.order_number}* sudah *SELESAI & SIAP DIAMBIL*! ✨`,
      ``,
      `💰 *Sisa Tagihan:* ${order.payment_status === 'PAID' ? 'Rp 0 (Sudah Lunas)' : formatIDR(order.remaining_amount)}`,
      ``,
      `Silakan ambil pakaian Anda di outlet pada jam operasional.`,
      `Detail nota: ${trackingUrl}`,
      ``,
      `Terima kasih dan ditunggu kedatangannya! 🙏`
    ].join('\n');
  }

  buildPaymentReceiptMessage(order: Order, customer: Customer, payment: Payment): string {
    return [
      `Halo Kak *${customer.name}*,`,
      ``,
      `Pembayaran Anda untuk nota *${order.order_number}* telah berhasil diterima.`,
      ``,
      `💵 *Nominal Pembayaran:* ${formatIDR(payment.amount)}`,
      `💳 *Metode:* ${payment.payment_method}`,
      `🏷️ *Sisa Tagihan:* ${formatIDR(order.remaining_amount)}`,
      ``,
      `Terima kasih telah bertransaksi di LaundryFlow!`
    ].join('\n');
  }

  launchWhatsApp(phone: string, message: string): void {
    const targetPhone = formatIndonesianPhone(phone);
    const encodedText = encodeURIComponent(message);
    const waUrl = `https://wa.me/${targetPhone}?text=${encodedText}`;
    window.open(waUrl, '_blank', 'noopener,noreferrer');
  }
}

export const notificationService = new WhatsAppLauncherService();
