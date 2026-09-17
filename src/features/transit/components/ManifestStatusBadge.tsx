import React from 'react';
import { TransitManifestStatus } from '../../../core/types/database';

interface ManifestStatusBadgeProps {
  status: TransitManifestStatus;
  className?: string;
  size?: 'sm' | 'md';
}

interface StatusConfig {
  label: string;
  className: string;
  dotColor: string;
}

const STATUS_CONFIGS: Record<TransitManifestStatus, StatusConfig> = {
  DRAFT: {
    label: 'Draft',
    className: 'bg-slate-100 text-slate-700 border-slate-200',
    dotColor: 'bg-slate-400',
  },
  READY_TO_DISPATCH: {
    label: 'Siap Dikirim',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
    dotColor: 'bg-amber-500',
  },
  IN_TRANSIT: {
    label: 'Dalam Perjalanan',
    className: 'bg-blue-50 text-blue-700 border-blue-200',
    dotColor: 'bg-blue-500',
  },
  RECEIVED: {
    label: 'Diterima',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dotColor: 'bg-emerald-500',
  },
  CANCELLED: {
    label: 'Dibatalkan',
    className: 'bg-rose-50 text-rose-700 border-rose-200',
    dotColor: 'bg-rose-500',
  },
};

export const ManifestStatusBadge: React.FC<ManifestStatusBadgeProps> = ({
  status,
  className = '',
  size = 'md',
}) => {
  const config = STATUS_CONFIGS[status] || {
    label: status,
    className: 'bg-slate-100 text-slate-700 border-slate-200',
    dotColor: 'bg-slate-400',
  };

  const sizeClasses =
    size === 'sm'
      ? 'px-2 py-0.5 text-[11px] gap-1'
      : 'px-2.5 py-1 text-xs gap-1.5';

  return (
    <span
      className={`inline-flex items-center font-semibold rounded-full border ${config.className} ${sizeClasses} ${className}`}
      data-testid={`manifest-status-badge-${status.toLowerCase()}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${config.dotColor} shrink-0`}
        aria-hidden="true"
      />
      <span>{config.label}</span>
    </span>
  );
};
