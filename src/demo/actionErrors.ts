import { ConvexError } from 'convex/values';
import { DEFINITION_ERROR_CODES } from '../../convex/definitionModel';
import { REQUEST_ERROR_CODES } from '../../convex/requestValues';

export const actionErrorKeys = new Map<string, string>([
  ['COLLECTION_NAME_INVALID', 'collections.nameInvalid'],
  ['COLLECTION_TITLE_INVALID', 'collections.titleRule'],
  ['COLLECTION_NAME_EXISTS', 'collections.nameExists'],
  ['COLLECTION_FIELD_NAME_DUPLICATE', 'collections.fieldNameDuplicate'],
  ['COLLECTION_FIELD_NAME_INVALID', 'collections.fieldInvalid'],
  ['COLLECTION_FIELD_COUNT_INVALID', 'collections.fieldCount'],
  ['COLLECTION_HAS_RECORDS', 'collections.deleteHasRecords'],
  ['COLLECTION_HAS_WORKFLOWS', 'collections.deleteHasWorkflows'],
  ['COLLECTION_NOT_FOUND', 'collections.notFound'],
  ['RECORD_FIELD_REQUIRED', 'records.required'],
  ['RECORD_FIELD_UNKNOWN', 'records.unknownField'],
  ['RECORD_FIELD_TYPE_INVALID', 'records.invalidType'],
  ['RECORD_TEXT_TOO_LONG', 'records.textTooLong'],
  ['RECORD_NOT_FOUND', 'records.notFound'],
  ['RECORD_COLLECTION_FULL', 'records.collectionFull'],
  ['RECORD_BROWSE_LIMIT_EXCEEDED', 'records.browseLimit'],
  ['RECORD_QUERY_FIELD_UNKNOWN', 'records.queryFieldUnknown'],
  ['RECORD_QUERY_OPERATOR_INVALID', 'records.queryOperatorInvalid'],
  ['RECORD_QUERY_VALUE_INVALID', 'records.queryValueInvalid'],
  ['RECORD_QUERY_FILTER_COUNT_INVALID', 'records.queryFilterCount'],
  ['RECORD_QUERY_SORT_INVALID', 'records.querySortInvalid'],
  ['RECORD_QUERY_PAGE_INVALID', 'records.queryPageInvalid'],
  ['APPLICATION_ACCESS_DENIED', 'membershipErrors.APPLICATION_ACCESS_DENIED'],
  ['PERMISSION_DENIED', 'membershipErrors.PERMISSION_DENIED'],
  ['SELF_ADMINISTRATION_DENIED', 'membershipErrors.SELF_ADMINISTRATION_DENIED'],
  ['MEMBERSHIP_NOT_FOUND', 'membershipErrors.MEMBERSHIP_NOT_FOUND'],
  ['MEMBERSHIP_INACTIVE', 'membershipErrors.MEMBERSHIP_INACTIVE'],
  ['MEMBERSHIP_LIST_LIMIT_EXCEEDED', 'membershipErrors.MEMBERSHIP_LIST_LIMIT_EXCEEDED'],
  ...DEFINITION_ERROR_CODES.map((code): [string, string] => [code, `definitionErrors.${code}`]),
]);

export type ActionErrorData = {
  code: string;
  field: string;
  currentRevision?: number;
  currentVersionId?: string;
  min?: number;
  max?: number;
  maxLength?: number;
};

function numberProperty(data: object, key: string): number | undefined {
  const value: unknown = Reflect.get(data, key);
  return typeof value === 'number' ? value : undefined;
}

export function actionErrorData(error: unknown): ActionErrorData | null {
  if (
    !(error instanceof ConvexError) ||
    typeof error.data !== 'object' ||
    error.data === null ||
    !('code' in error.data) ||
    typeof error.data.code !== 'string'
  ) {
    return null;
  }
  const field = 'field' in error.data && typeof error.data.field === 'string' ? error.data.field : '';
  const currentVersionId =
    'currentVersionId' in error.data && typeof error.data.currentVersionId === 'string'
      ? error.data.currentVersionId
      : undefined;
  return {
    code: error.data.code,
    field,
    currentRevision: numberProperty(error.data, 'currentRevision'),
    currentVersionId,
    min: numberProperty(error.data, 'min'),
    max: numberProperty(error.data, 'max'),
    maxLength: numberProperty(error.data, 'maxLength'),
  };
}

type RequestIssueText = { code: string; field?: string; min?: number; max?: number; maxLength?: number };

// Request errors name a field by key; the message shows the label of the pinned version in the active language.
export function requestIssueMessage(
  issue: RequestIssueText,
  t: (key: string, options?: Record<string, string | number | undefined>) => string,
  labelOf: (key: string) => string,
): string {
  const isRequestCode = REQUEST_ERROR_CODES.some((code) => code === issue.code);
  if (!isRequestCode) return t(actionErrorKeys.get(issue.code) ?? 'common.actionFailed', { field: issue.field ?? '' });
  return t(`requestErrors.${issue.code}`, {
    field: issue.field ? labelOf(issue.field) : '',
    min: issue.min,
    max: issue.max,
    maxLength: issue.maxLength,
  });
}

export function actionErrorMessage(error: unknown, t: (key: string, options?: { field: string }) => string): string {
  const data = actionErrorData(error);
  if (!data) return t('common.actionFailed');
  return t(actionErrorKeys.get(data.code) ?? 'common.actionFailed', { field: data.field });
}
