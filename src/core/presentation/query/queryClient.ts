// ============================================================================
// LaundryFlow Presentation Layer — Centralized QueryClient Instance
// (Safe error-aware retries, zero hardcoded magic settings)
// ============================================================================

import { QueryClient } from '@tanstack/react-query';
import { ApplicationError } from '../../application/laundryApplicationService';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Do not retry predictable client/authorization/not-found errors
        if (error instanceof ApplicationError) {
          if (
            error.code === 'VALIDATION_ERROR' ||
            error.code === 'FORBIDDEN' ||
            error.code === 'NOT_FOUND' ||
            error.code === 'INVALID_STATE'
          ) {
            return false;
          }
        }
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
      staleTime: 1000 * 30, // 30 seconds fresh window
    },
    mutations: {
      retry: false, // Never automatically re-dispatch state-changing business mutations
    },
  },
});
