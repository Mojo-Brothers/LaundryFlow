// ============================================================================
// RBAC Roles & Granular Permission Definitions
// ============================================================================

import { UserRole } from './database';

export type PermissionKey =
  | 'orders.create'
  | 'orders.view'
  | 'orders.update_status'
  | 'orders.cancel'
  | 'orders.discount_override'
  | 'payments.create'
  | 'payments.view'
  | 'payments.refund'
  | 'shifts.manage'
  | 'services.manage'
  | 'inventory.view'
  | 'inventory.adjust'
  | 'users.manage'
  | 'reports.view'
  | 'audit.view';

export const ROLE_PERMISSIONS: Record<UserRole, PermissionKey[]> = {
  OWNER: [
    'orders.create',
    'orders.view',
    'orders.update_status',
    'orders.cancel',
    'orders.discount_override',
    'payments.create',
    'payments.view',
    'payments.refund',
    'shifts.manage',
    'services.manage',
    'inventory.view',
    'inventory.adjust',
    'users.manage',
    'reports.view',
    'audit.view'
  ],
  ADMIN: [
    'orders.create',
    'orders.view',
    'orders.update_status',
    'orders.cancel',
    'orders.discount_override',
    'payments.create',
    'payments.view',
    'payments.refund',
    'shifts.manage',
    'services.manage',
    'inventory.view',
    'inventory.adjust',
    'users.manage',
    'reports.view',
    'audit.view'
  ],
  MANAGER: [
    'orders.create',
    'orders.view',
    'orders.update_status',
    'orders.cancel',
    'orders.discount_override',
    'payments.create',
    'payments.view',
    'shifts.manage',
    'inventory.view',
    'inventory.adjust',
    'reports.view'
  ],
  BRANCH_MANAGER: [
    'orders.create',
    'orders.view',
    'orders.update_status',
    'orders.cancel',
    'payments.create',
    'payments.view',
    'shifts.manage',
    'inventory.view',
    'inventory.adjust',
    'reports.view'
  ],
  CASHIER: [
    'orders.create',
    'orders.view',
    'orders.update_status',
    'payments.create',
    'payments.view',
    'shifts.manage',
    'inventory.view'
  ],
  OPERATOR: [
    'orders.view',
    'orders.update_status',
    'inventory.view'
  ],
  DRIVER: [
    'orders.view',
    'orders.update_status',
    'payments.create' // for Cash On Delivery collection
  ],
  VIEWER: [
    'orders.view',
    'reports.view'
  ]
};

export function hasPermission(role: UserRole, permission: PermissionKey): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  return permissions ? permissions.includes(permission) : false;
}
