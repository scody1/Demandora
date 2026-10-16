import { UserRole, ForecastStatus } from '../types';

export const Permissions = {
  canGenerate: (role: UserRole) => role === 'PLANNER' || role === 'ADMINISTRATOR',
  canEditAdjustment: (role: UserRole) => role === 'PLANNER' || role === 'ADMINISTRATOR',
  canSaveDraft: (role: UserRole, status: ForecastStatus) => (role === 'PLANNER' || role === 'ADMINISTRATOR') && status !== 'Submitted' && status !== 'Approved',
  canSubmit: (role: UserRole, status: ForecastStatus) => (role === 'PLANNER' || role === 'ADMINISTRATOR') && status !== 'Submitted' && status !== 'Approved',
  canApprove: (role: UserRole, status: ForecastStatus) => (role === 'APPROVER' || role === 'ADMINISTRATOR') && status === 'Submitted',
  canReturn: (role: UserRole, status: ForecastStatus) => (role === 'APPROVER' || role === 'ADMINISTRATOR') && status === 'Submitted',
  canReviewPlanningImplications: (role: UserRole) => role === 'PURCHASE_MANAGER' || role === 'PLANNER' || role === 'ADMINISTRATOR' || role === 'APPROVER',
  canAdminister: (role: UserRole) => role === 'ADMINISTRATOR'
};
