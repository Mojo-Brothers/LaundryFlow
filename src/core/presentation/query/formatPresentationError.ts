// ============================================================================
// LaundryFlow Presentation Layer — Error Formatting & Presentation Adapter
// (Translates ApplicationErrors into actionable, human-readable UI messages)
// ============================================================================

import { ApplicationError, ApplicationErrorCode } from '../../application/laundryApplicationService';

export interface FormattedPresentationError {
  code: ApplicationErrorCode | 'UNKNOWN_ERROR';
  title: string;
  message: string;
  actionHint: string;
  isRetryable: boolean;
}

/**
 * Formats any caught presentation error into an Indonesian, actionable UI view.
 * Prevents raw database strings or stack traces from reaching end-users while
 * preserving clear instructions on how to resolve the situation.
 */
export function formatPresentationError(err: unknown): FormattedPresentationError {
  if (err instanceof ApplicationError) {
    switch (err.code) {
      case 'VALIDATION_ERROR':
        return {
          code: 'VALIDATION_ERROR',
          title: 'Periksa Kembali Input Data',
          message: err.message,
          actionHint: 'Mohon periksa kolom yang ditandai dan lengkapi data dengan benar.',
          isRetryable: false,
        };

      case 'CONFLICT':
        return {
          code: 'CONFLICT',
          title: 'Konflik Data Terdeteksi',
          message: err.message,
          actionHint: 'Order sudah berada dalam manifest aktif lain atau data telah diperbarui. Silakan muat ulang.',
          isRetryable: true,
        };

      case 'FORBIDDEN':
        return {
          code: 'FORBIDDEN',
          title: 'Akses Ditolak',
          message: err.message,
          actionHint: 'Akun Anda tidak memiliki izin otorisasi untuk cabang atau tindakan ini.',
          isRetryable: false,
        };

      case 'NOT_FOUND':
        return {
          code: 'NOT_FOUND',
          title: 'Data Tidak Ditemukan',
          message: err.message,
          actionHint: 'Data manifest, order, atau shift tidak ditemukan di sistem.',
          isRetryable: false,
        };

      case 'INVALID_STATE':
        return {
          code: 'INVALID_STATE',
          title: 'Transisi Status Tidak Diizinkan',
          message: err.message,
          actionHint: 'Status saat ini tidak dapat dialihkan ke status tujuan. Ikuti urutan tahapan yang benar.',
          isRetryable: false,
        };

      case 'FINANCIAL_ERROR':
        return {
          code: 'FINANCIAL_ERROR',
          title: 'Selisih Kas Terdeteksi',
          message: err.message,
          actionHint: 'Wajib mencantumkan catatan selisih (variance note) minimal 5 karakter untuk menutup shift.',
          isRetryable: false,
        };

      case 'DATABASE_ERROR':
      default:
        return {
          code: 'DATABASE_ERROR',
          title: 'Gangguan Sistem / Jaringan',
          message: err.message || 'Terjadi gangguan saat menghubungkan ke database server.',
          actionHint: 'Silakan periksa koneksi internet Anda dan coba beberapa saat lagi.',
          isRetryable: true,
        };
    }
  }

  const rawMsg = err instanceof Error ? err.message : String(err);
  return {
    code: 'UNKNOWN_ERROR',
    title: 'Terjadi Kendala Tidak Terduga',
    message: rawMsg || 'Kesalahan sistem presentation tidak terduga.',
    actionHint: 'Muat ulang halaman atau hubungi administrator sistem.',
    isRetryable: true,
  };
}
