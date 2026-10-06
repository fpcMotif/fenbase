import { ConvexError } from 'convex/values';
import { DEFINITION_ERROR_CODES } from '../../convex/definitionModel';

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

export type ActionErrorData = { code: string; field: string; currentRevision?: number };

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
  const currentRevision =
    'currentRevision' in error.data && typeof error.data.currentRevision === 'number'
      ? error.data.currentRevision
      : undefined;
  return { code: error.data.code, field, currentRevision };
}

export function actionErrorMessage(error: unknown, t: (key: string, options?: { field: string }) => string): string {
  const data = actionErrorData(error);
  if (!data) return t('common.actionFailed');
  return t(actionErrorKeys.get(data.code) ?? 'common.actionFailed', { field: data.field });
}
