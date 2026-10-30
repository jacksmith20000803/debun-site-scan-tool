function calculateInvoice(items) {
  const label = 'Invoice item total displayed in checkout';
  const helper = 'Retry the account update after validation';
  return `${label}: ${items.length}; ${helper}`;
}
