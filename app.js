'use strict';

/* =====================================================================
   Run Tracker - Sprint 1 (client-side only)
   Sections:
     1. Constants & state
     2. DOM references
     3. Helpers (dates, pace, formatting)
     4. Validation
     5. Run data functions (add / delete / select)
     6. Rendering
     7. Analyze Run (local simulation of the future AI call)
     8. Event listeners & startup
   ===================================================================== */

/* ---------- 1. Constants & state ---------- */
const MAX_DISTANCE_MILES = 100;
const MIN_PACE_SECONDS_PER_MILE = 240; // faster than 4:00/mi is treated as a typo
const ANALYSIS_DELAY_MS = 700;         // fake "thinking" delay so the loading state is visible
const HISTORY_WINDOW = 3;              // how many previous runs the analysis compares against

let runs = [];            // every saved run lives here
let nextRunId = 1;        // simple incrementing id
let selectedRunId = null; // id of the run currently selected, or null
let analysisTimer = null; // handle for the pending fake-AI delay
let statusTimer = null;   // handle for the "Run saved!" message timeout

/* ---------- 2. DOM references ---------- */
const form = document.getElementById('run-form');
const dateInput = document.getElementById('run-date');
const distanceInput = document.getElementById('run-distance');
const hoursInput = document.getElementById('run-hours');
const minutesInput = document.getElementById('run-minutes');
const secondsInput = document.getElementById('run-seconds');
const typeSelect = document.getElementById('run-type');
const notesInput = document.getElementById('run-notes');
const notesCount = document.getElementById('notes-count');
const formStatus = document.getElementById('form-status');

const runList = document.getElementById('run-list');
const runCount = document.getElementById('run-count');
const emptyState = document.getElementById('empty-state');

const weeklyGoal = document.getElementById('weekly-goal');
const weeklyGoalFill = document.getElementById('weekly-goal-fill');
const weeklyGoalText = document.getElementById('weekly-goal-text');

const analysisPanel = document.getElementById('analysis-panel');
const analysisPlaceholder = document.getElementById('analysis-placeholder');
const selectedDetails = document.getElementById('selected-run-details');
const analyzeBtn = document.getElementById('analyze-btn');
const analysisOutput = document.getElementById('analysis-output');

/* ---------- 3. Helpers ---------- */

// Local-time YYYY-MM-DD (toISOString would shift the date into UTC).
function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayISO() {
  return toISODate(new Date());
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toISODate(d);
}

function formatDate(isoDate) {
  // Adding T00:00:00 makes the browser read it as local time, not UTC.
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

function formatPace(secondsPerMile) {
  const rounded = Math.round(secondsPerMile);
  return `${Math.floor(rounded / 60)}:${pad2(rounded % 60)} /mi`;
}

function calculatePaceSeconds(distanceMiles, totalSeconds) {
  return totalSeconds / distanceMiles;
}

// "Long Run" -> "long-run" (used for data-type attributes and CSS selectors)
function slugify(text) {
  return text.toLowerCase().replace(/\s+/g, '-');
}

// Tiny helper for building elements safely (textContent never parses HTML).
function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function getSelectedRun() {
  return runs.find((run) => run.id === selectedRunId) || null;
}

// Newest first. Same date -> higher id (saved later) first.
function sortedNewestFirst() {
  return [...runs].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.id - a.id;
  });
}

/* ---------- 4. Validation ---------- */

// Takes raw form values, returns an object of error messages (empty object = valid).
function validateRunForm(values) {
  const errors = {};
  const { date, distance, hours, minutes, seconds, type } = values;

  if (!date) {
    errors.date = 'Please choose a date.';
  } else if (date > todayISO()) {
    errors.date = 'The date cannot be in the future.';
  }

  if (Number.isNaN(distance) || distance <= 0) {
    errors.distance = 'Enter a distance greater than 0.';
  } else if (distance > MAX_DISTANCE_MILES) {
    errors.distance = `Distance cannot exceed ${MAX_DISTANCE_MILES} miles.`;
  }

  const timePartsValid =
    Number.isInteger(hours) && hours >= 0 && hours <= 24 &&
    Number.isInteger(minutes) && minutes >= 0 && minutes <= 59 &&
    Number.isInteger(seconds) && seconds >= 0 && seconds <= 59;

  if (!timePartsValid) {
    errors.time = 'Use whole numbers: hours 0-24, minutes 0-59, seconds 0-59.';
  } else if (hours * 3600 + minutes * 60 + seconds <= 0) {
    errors.time = 'Time must be greater than 0.';
  } else if (!errors.distance) {
    const pace = calculatePaceSeconds(distance, hours * 3600 + minutes * 60 + seconds);
    if (pace < MIN_PACE_SECONDS_PER_MILE) {
      errors.time = 'That pace is faster than 4:00/mi. Please double-check distance and time.';
    }
  }

  if (!type) {
    errors.type = 'Please choose a workout type.';
  }

  return errors;
}

function clearErrors() {
  document.querySelectorAll('.error').forEach((el) => { el.textContent = ''; });
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
}

function showErrors(errors) {
  clearErrors();
  const fieldMap = {
    date: [dateInput],
    distance: [distanceInput],
    time: [hoursInput, minutesInput, secondsInput],
    type: [typeSelect],
  };
  Object.entries(errors).forEach(([field, message]) => {
    const messageEl = document.querySelector(`[data-error-for="${field}"]`);
    if (messageEl) messageEl.textContent = message;
    fieldMap[field].forEach((input) => input.setAttribute('aria-invalid', 'true'));
  });
}

function readFormValues() {
  // Empty time boxes count as 0 so "25 min" doesn't require typing 0 in the others.
  const toInt = (input) => (input.value === '' ? 0 : Number(input.value));
  return {
    date: dateInput.value,
    distance: distanceInput.value === '' ? NaN : Number(distanceInput.value),
    hours: toInt(hoursInput),
    minutes: toInt(minutesInput),
    seconds: toInt(secondsInput),
    type: typeSelect.value,
    notes: notesInput.value.trim(),
  };
}

/* ---------- 5. Run data functions ---------- */

function addRun({ date, distance, totalSeconds, type, notes }) {
  const run = {
    id: nextRunId++,
    date,
    distance,
    totalSeconds,
    paceSeconds: calculatePaceSeconds(distance, totalSeconds),
    type,
    notes,
  };
  runs.push(run);
  return run;
}

function deleteRun(runId) {
  runs = runs.filter((run) => run.id !== runId);
  if (runId === selectedRunId) {
    selectedRunId = null; // the selected run is gone, so clear selection + summary
    clearTimeout(analysisTimer);
  }
  renderAll();
}

function selectRun(runId) {
  clearTimeout(analysisTimer); // cancel any in-flight analysis for a different run
  selectedRunId = runId;
  renderAll();
  const selectedCard = runList.querySelector('[data-selected="true"]');
  if (selectedCard) selectedCard.focus();
}

/* ---------- 6. Rendering ---------- */

function buildRunCard(run) {
  const card = createEl('li', 'run-card');
  card.dataset.runId = String(run.id);
  card.dataset.type = slugify(run.type);
  card.dataset.selected = String(run.id === selectedRunId);
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-pressed', String(run.id === selectedRunId));

  const top = createEl('div', 'run-card-top');
  top.append(createEl('span', 'run-date', formatDate(run.date)));
  top.append(createEl('span', 'type-badge', run.type));

  const stats = createEl('div', 'run-stats');
  [
    ['Distance', `${run.distance.toFixed(2)} mi`],
    ['Time', formatDuration(run.totalSeconds)],
    ['Pace', formatPace(run.paceSeconds)],
  ].forEach(([label, value]) => {
    const item = createEl('span', null, `${label}: `);
    item.append(createEl('strong', null, value));
    stats.append(item);
  });

  card.append(top, stats);

  if (run.notes) {
    card.append(createEl('p', 'run-notes', run.notes));
  }

  const deleteBtn = createEl('button', 'delete-btn', '\u00D7');
  deleteBtn.type = 'button';
  deleteBtn.setAttribute('aria-label', `Delete run from ${formatDate(run.date)}`);
  card.append(deleteBtn);

  return card;
}

function renderHistory() {
  const ordered = sortedNewestFirst();
  runList.replaceChildren(...ordered.map(buildRunCard));

  runList.dataset.runCount = String(runs.length);
  runCount.textContent = `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`;
  emptyState.hidden = runs.length > 0;
}

function renderWeeklyGoal() {
  const goalMiles = Number(weeklyGoal.dataset.goalMiles); // state read from the HTML data-* attribute
  const cutoff = daysAgoISO(6);
  const today = todayISO();

  const weeklyMiles = runs
    .filter((run) => run.date >= cutoff && run.date <= today)
    .reduce((sum, run) => sum + run.distance, 0);

  const percent = Math.min(100, (weeklyMiles / goalMiles) * 100);
  weeklyGoalFill.style.width = `${percent}%`;                 // style/geometry update
  weeklyGoal.dataset.met = String(weeklyMiles >= goalMiles);  // attribute update (CSS recolors the bar)
  weeklyGoalText.textContent = `${weeklyMiles.toFixed(1)} / ${goalMiles} mi`;

  const progressBar = weeklyGoal.querySelector('[role="progressbar"]');
  progressBar.setAttribute('aria-valuenow', String(Math.round(percent)));
}

function renderAnalysisPanel() {
  const run = getSelectedRun();

  // Any selection change resets the output area; the Analyze button fills it in.
  analysisOutput.replaceChildren();
  analysisPanel.dataset.state = 'idle';

  if (!run) {
    analysisPlaceholder.hidden = false;
    selectedDetails.hidden = true;
    analyzeBtn.disabled = true; // boundary: nothing to analyze
    return;
  }

  analysisPlaceholder.hidden = true;
  selectedDetails.hidden = false;
  analyzeBtn.disabled = false;

  document.getElementById('detail-date').textContent = formatDate(run.date);
  document.getElementById('detail-distance').textContent = `${run.distance.toFixed(2)} mi`;
  document.getElementById('detail-time').textContent = formatDuration(run.totalSeconds);
  document.getElementById('detail-pace').textContent = formatPace(run.paceSeconds);
  document.getElementById('detail-type').textContent = run.type;
}

function renderAll() {
  renderHistory();
  renderWeeklyGoal();
  renderAnalysisPanel();
}

/* ---------- 7. Analyze Run ---------- */

// Returns the (up to) HISTORY_WINDOW runs that happened before `run`, newest first.
function getPreviousRuns(run) {
  return sortedNewestFirst()
    .filter((other) => other.date < run.date || (other.date === run.date && other.id < run.id))
    .slice(0, HISTORY_WINDOW);
}

/*
  generateAnalysis(run, previousRuns) -> array of paragraph strings.

  SPRINT 1: builds the summary from templates using simple math.
  LATER SPRINT: replace the body of this function with a real LLM request.
  The inputs (selected run + previous 2-3 runs) are already the right prompt context.
*/
function generateAnalysis(run, previousRuns) {
  const paragraphs = [];

  if (previousRuns.length === 0) {
    paragraphs.push(
      `This is your first logged run: ${run.distance.toFixed(2)} mi at ${formatPace(run.paceSeconds)}. ` +
      'It becomes your baseline, so log a few more and the analysis will start showing trends.'
    );
    return paragraphs;
  }

  const count = previousRuns.length;
  const runWord = count === 1 ? 'run' : 'runs';

  // Pace comparison
  const avgPace = previousRuns.reduce((sum, r) => sum + r.paceSeconds, 0) / count;
  const paceDiff = Math.round(run.paceSeconds - avgPace); // negative = faster
  if (Math.abs(paceDiff) <= 5) {
    paragraphs.push(
      `Your pace of ${formatPace(run.paceSeconds)} was right in line with your average of ` +
      `${formatPace(avgPace)} over your previous ${count} ${runWord}.`
    );
  } else if (paceDiff < 0) {
    paragraphs.push(
      `Your pace of ${formatPace(run.paceSeconds)} was ${Math.abs(paceDiff)} sec/mi faster than your ` +
      `average of ${formatPace(avgPace)} over your previous ${count} ${runWord}.`
    );
  } else {
    paragraphs.push(
      `Your pace of ${formatPace(run.paceSeconds)} was ${paceDiff} sec/mi slower than your ` +
      `average of ${formatPace(avgPace)} over your previous ${count} ${runWord}. ` +
      'That is normal on harder, hillier, or more tired days.'
    );
  }

  // Distance comparison
  const longestPrevious = Math.max(...previousRuns.map((r) => r.distance));
  if (run.distance > longestPrevious) {
    paragraphs.push(
      `At ${run.distance.toFixed(2)} mi, this was your longest run of the last ${count + 1}, ` +
      `up from ${longestPrevious.toFixed(2)} mi. Nice endurance progress.`
    );
  } else {
    const avgDistance = previousRuns.reduce((sum, r) => sum + r.distance, 0) / count;
    paragraphs.push(
      `You covered ${run.distance.toFixed(2)} mi compared with an average of ${avgDistance.toFixed(2)} mi recently.`
    );
  }

  // Workout-type tip
  const tips = {
    'Easy': 'Easy runs build your aerobic base, so keeping the effort conversational is the goal.',
    'Long Run': 'Long runs are the backbone of endurance. Refuel and give yourself an easy day next.',
    'Tempo': 'Tempo runs train you to hold a strong pace. Compare how the last mile felt to the first.',
    'Intervals': 'Intervals are hard by design. Make sure the next day is easy or a rest day.',
    'Recovery': 'Recovery runs should feel almost too easy. A slower pace here is a good sign.',
    'Race': 'Race effort is a great benchmark. Use it to set targets for your training paces.',
  };
  if (tips[run.type]) paragraphs.push(tips[run.type]);

  return paragraphs;
}

function handleAnalyzeClick() {
  const run = getSelectedRun();
  if (!run) return; // safety net; the button is disabled in this case

  const analyzingRunId = run.id;
  analyzeBtn.disabled = true;
  analysisPanel.dataset.state = 'loading';
  analysisOutput.replaceChildren(createEl('p', null, 'Analyzing your run...'));

  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(() => {
    // If the user selected another run or deleted this one meanwhile, do nothing.
    if (selectedRunId !== analyzingRunId) return;

    const paragraphs = generateAnalysis(run, getPreviousRuns(run));
    analysisOutput.replaceChildren(...paragraphs.map((text) => createEl('p', null, text)));
    analysisPanel.dataset.state = 'done';
    analyzeBtn.disabled = false;
  }, ANALYSIS_DELAY_MS);
}

/* ---------- 8. Event listeners & startup ---------- */

function showStatus(message) {
  formStatus.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { formStatus.textContent = ''; }, 2500);
}

function resetForm() {
  form.reset();
  dateInput.value = todayISO();
  notesCount.textContent = '0';
  clearErrors();
}

form.addEventListener('submit', (event) => {
  event.preventDefault(); // stop the browser from reloading the page

  const values = readFormValues();
  const errors = validateRunForm(values);

  if (Object.keys(errors).length > 0) {
    showErrors(errors);
    return;
  }

  addRun({
    date: values.date,
    distance: values.distance,
    totalSeconds: values.hours * 3600 + values.minutes * 60 + values.seconds,
    type: values.type,
    notes: values.notes,
  });

  resetForm();
  renderAll();
  showStatus('Run saved!');
});

notesInput.addEventListener('input', () => {
  notesCount.textContent = String(notesInput.value.length);
});

// Event delegation: one listener on the <ul> handles every card, even ones added later.
runList.addEventListener('click', (event) => {
  const card = event.target.closest('.run-card');
  if (!card) return;
  const runId = Number(card.dataset.runId);

  if (event.target.closest('.delete-btn')) {
    deleteRun(runId);
  } else {
    selectRun(runId);
  }
});

// Keyboard support: Enter or Space on a focused card selects it.
runList.addEventListener('keydown', (event) => {
  if (!event.target.classList.contains('run-card')) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectRun(Number(event.target.dataset.runId));
  }
});

analyzeBtn.addEventListener('click', handleAnalyzeClick);

function loadSeedRuns() {
  const seed = [
    { daysAgo: 12, distance: 3.1, minutes: 29, seconds: 40, type: 'Easy', notes: 'Felt relaxed.' },
    { daysAgo: 9, distance: 4.0, minutes: 33, seconds: 20, type: 'Tempo', notes: 'Strong second half.' },
    { daysAgo: 6, distance: 3.0, minutes: 28, seconds: 30, type: 'Easy', notes: '' },
    { daysAgo: 3, distance: 6.2, minutes: 58, seconds: 10, type: 'Long Run', notes: 'Hot and humid.' },
    { daysAgo: 1, distance: 3.5, minutes: 29, seconds: 15, type: 'Intervals', notes: '6 x 400m repeats.' },
  ];
  seed.forEach((s) => addRun({
    date: daysAgoISO(s.daysAgo),
    distance: s.distance,
    totalSeconds: s.minutes * 60 + s.seconds,
    type: s.type,
    notes: s.notes,
  }));
}

function init() {
  dateInput.value = todayISO();
  dateInput.max = todayISO(); // browser-level guard against future dates
  loadSeedRuns();
  renderAll();
}

init();
