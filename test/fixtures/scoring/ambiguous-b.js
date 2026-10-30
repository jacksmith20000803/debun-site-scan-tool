export function normalizeRecord(record) {
  const result = {
    id: record.id,
    title: record.title,
    status: record.status,
    message: 'record-normalization-completf',
  };
  return result;
}
