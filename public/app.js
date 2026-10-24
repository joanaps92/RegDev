const form = document.querySelector('#returnForm');
const paidInput = document.querySelector('#paidTotal');
const returnedInput = document.querySelector('#returnedAmount');
const resultOutput = document.querySelector('#remainingAmount');
const formError = document.querySelector('#formError');
const calculateButton = document.querySelector('#calculateButton');
const dateInput = document.querySelector('#historyDate');
const historyRows = document.querySelector('#historyRows');
const emptyState = document.querySelector('#emptyState');
const tableWrap = document.querySelector('#tableWrap');
const loadingState = document.querySelector('#loadingState');
const toast = document.querySelector('#toast');
const textSizeButton = document.querySelector('#textSizeButton');
const exportMonthInput = document.querySelector('#exportMonth');
const exportMonthButton = document.querySelector('#exportMonthButton');

const moneyFormatter = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dateFormatter = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

let toastTimer;

function setExtraLargeText(enabled) {
  document.body.classList.toggle('extra-large', enabled);
  textSizeButton.setAttribute('aria-pressed', String(enabled));
  textSizeButton.setAttribute('aria-label', enabled ? 'Desactivar texto extra grande' : 'Activar texto extra grande');
  textSizeButton.title = enabled ? 'Reducir texto' : 'Ampliar texto';
  try {
    localStorage.setItem('cajaclara-extra-large-text', String(enabled));
  } catch {
    // The larger text still works when browser storage is unavailable.
  }
}

try {
  setExtraLargeText(localStorage.getItem('cajaclara-extra-large-text') === 'true');
} catch {
  setExtraLargeText(false);
}

function parseCents(value) {
  const normalized = String(value).trim().replace(',', '.');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

function centsToMoney(cents) {
  return moneyFormatter.format(cents / 100);
}

function selectedDateLabel(dateString) {
  const date = new Date(`${dateString}T12:00:00Z`);
  const label = dateFormatter.format(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function updateCalculation() {
  const paidCents = parseCents(paidInput.value);
  const returnedCents = parseCents(returnedInput.value);
  const valid = paidCents !== null && returnedCents !== null;
  resultOutput.textContent = valid ? centsToMoney(paidCents - returnedCents) : '—';
  resultOutput.classList.toggle('negative', valid && paidCents < returnedCents);
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = !message;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

function makeCell(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function renderHistory(data) {
  dateInput.value = data.date;
  document.querySelector('#selectedDayLabel').textContent = selectedDateLabel(data.date);
  const isLatest = data.latestDate === data.date;
  document.querySelector('#latestLabel').textContent = isLatest
    ? 'Último día procesado'
    : data.latestDate
      ? `Último día con actividad: ${selectedDateLabel(data.latestDate)}`
      : 'Todavía no hay movimientos';
  document.querySelector('#dayCount').textContent = data.summary.count;
  document.querySelector('#dayReturnedTotal').textContent = centsToMoney(data.summary.returnedCents);

  historyRows.replaceChildren();
  for (const entry of data.entries) {
    const row = document.createElement('tr');
    row.append(
      makeCell(entry.time),
      makeCell(centsToMoney(entry.paidTotalCents)),
      makeCell(centsToMoney(entry.returnedCents)),
      makeCell(centsToMoney(entry.remainingCents)),
    );
    historyRows.append(row);
  }

  const hasEntries = data.entries.length > 0;
  tableWrap.classList.toggle('is-empty', !hasEntries);
  emptyState.hidden = hasEntries;
  tableWrap.querySelector('table').hidden = !hasEntries;
}

async function loadHistory(date) {
  tableWrap.hidden = true;
  loadingState.hidden = false;
  try {
    const url = new URL('api/returns', document.baseURI);
    if (date) url.searchParams.set('date', date);
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudo cargar el histórico.');
    renderHistory(data);
  } catch (error) {
    showToast(error.message || 'No se pudo cargar el histórico.');
  } finally {
    loadingState.hidden = true;
    tableWrap.hidden = false;
  }
}

async function saveReturn(event) {
  event.preventDefault();
  showError('');

  const paidCents = parseCents(paidInput.value);
  const returnedCents = parseCents(returnedInput.value);
  if (paidCents === null || returnedCents === null) {
    showError('Completa ambos importes con hasta dos decimales.');
    (paidCents === null ? paidInput : returnedInput).focus();
    return;
  }

  calculateButton.disabled = true;
  calculateButton.querySelector('span:first-child').textContent = 'Guardando…';
  try {
    const response = await fetch(new URL('api/returns', document.baseURI), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paidTotal: paidInput.value,
        returnedAmount: returnedInput.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudo guardar la devolución.');

    form.reset();
    updateCalculation();
    await loadHistory(data.entry.date);
    paidInput.focus();
    showToast('Devolución calculada y guardada.');
  } catch (error) {
    showError(error.message || 'No se pudo guardar la devolución.');
  } finally {
    calculateButton.disabled = false;
    calculateButton.querySelector('span:first-child').textContent = 'Calcular y guardar';
  }
}

async function downloadMonthlyExcel() {
  const month = exportMonthInput.value;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    showToast('Elige el mes que quieres descargar.');
    exportMonthInput.focus();
    return;
  }

  const originalButtonContent = exportMonthButton.innerHTML;
  exportMonthButton.disabled = true;
  exportMonthButton.innerHTML = 'Preparando Excel…';

  try {
    const url = new URL('api/returns/export', document.baseURI);
    url.searchParams.set('month', month);
    const response = await fetch(url);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'No se pudo descargar el Excel.');
    }

    const fileUrl = URL.createObjectURL(await response.blob());
    const downloadLink = document.createElement('a');
    downloadLink.href = fileUrl;
    downloadLink.download = `devoluciones-${month}.xlsx`;
    document.body.append(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    window.setTimeout(() => URL.revokeObjectURL(fileUrl), 1000);
    showToast('Excel mensual descargado.');
  } catch (error) {
    showToast(error.message || 'No se pudo descargar el Excel.');
  } finally {
    exportMonthButton.disabled = false;
    exportMonthButton.innerHTML = originalButtonContent;
  }
}

function updateTodayLabel() {
  const now = new Date();
  document.querySelector('#todayLabel').textContent = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(now);
}

paidInput.addEventListener('input', updateCalculation);
returnedInput.addEventListener('input', updateCalculation);
form.addEventListener('submit', saveReturn);
dateInput.addEventListener('change', () => {
  if (dateInput.value) loadHistory(dateInput.value);
});
const currentMonthParts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
}).formatToParts(new Date()).map(({ type, value }) => [type, value]));
exportMonthInput.value = `${currentMonthParts.year}-${currentMonthParts.month}`;
exportMonthButton.addEventListener('click', downloadMonthlyExcel);
textSizeButton.addEventListener('click', () => {
  setExtraLargeText(!document.body.classList.contains('extra-large'));
});

updateTodayLabel();
loadHistory();
