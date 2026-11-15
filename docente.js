const form = document.getElementById('reportForm');
const tokenInput = document.getElementById('reportToken');
const submitButton = document.getElementById('reportSubmit');
const statusMessage = document.getElementById('reportStatus');
const resultsSection = document.getElementById('reportResults');
const rowsContainer = document.getElementById('reportRows');
const studentCount = document.getElementById('studentCount');
const downloadButton = document.getElementById('downloadReport');
let reportRows = [];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function summarizeMission(student, grade, missionNumber, mission, completedChallenges) {
  const completedPhases = Object.values(isObject(mission.completed) ? mission.completed : {})
    .filter((value) => value === true).length;
  const awardedPoints = Object.values(isObject(mission.awarded) ? mission.awarded : {})
    .reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
  const evidence = isObject(mission.evidence) ? mission.evidence : {};
  const completed = completedChallenges.includes(missionNumber);
  const hasProgress = completed || completedPhases > 0
    || awardedPoints > 0 || Object.keys(evidence).length > 0;

  return {
    student,
    grade,
    mission: missionNumber,
    status: completed ? 'Completado' : hasProgress ? 'En progreso' : 'Sin iniciar',
    completedPhases,
    awardedPoints,
    evidence
  };
}

function createReportRows(students) {
  return students.flatMap((student) => {
    const allGradeData = isObject(student.gradeData) ? student.gradeData : {};
    const grades = [4, 5].filter((grade) => (
      Number(student.grade) === grade
      || (isObject(allGradeData[String(grade)]) && Object.keys(allGradeData[String(grade)]).length > 0)
    ));

    if (grades.length === 0) {
      return [{
        student: student.username,
        grade: 'Sin seleccionar',
        mission: '',
        status: 'Sin iniciar',
        completedPhases: 0,
        awardedPoints: 0,
        evidence: {}
      }];
    }

    return grades.flatMap((grade) => {
      const gradeData = isObject(allGradeData[String(grade)]) ? allGradeData[String(grade)] : {};
      const missions = isObject(gradeData.missions) ? { ...gradeData.missions } : {};
      if (!missions['1'] && isObject(gradeData.mission)) missions['1'] = gradeData.mission;
      const completedChallenges = Array.isArray(gradeData.completedChallenges)
        ? gradeData.completedChallenges.map(Number)
        : [];
      return [1, 2, 3, 4, 5].map((missionNumber) => {
        const mission = isObject(missions[String(missionNumber)]) ? missions[String(missionNumber)] : {};
        return summarizeMission(student.username, grade, missionNumber, mission, completedChallenges);
      });
    });
  }).sort((left, right) => (
    left.student.localeCompare(right.student, 'es')
    || String(left.grade).localeCompare(String(right.grade), 'es')
    || Number(left.mission || 0) - Number(right.mission || 0)
  ));
}

function createCell(tagName, text) {
  const cell = document.createElement(tagName);
  cell.textContent = text;
  return cell;
}

function renderRows(rows) {
  const fragment = document.createDocumentFragment();
  rows.forEach((row) => {
    const tableRow = document.createElement('tr');
    tableRow.append(
      createCell('td', row.student),
      createCell('td', String(row.grade)),
      createCell('td', row.mission ? String(row.mission) : '—'),
      createCell('td', row.status),
      createCell('td', String(row.completedPhases)),
      createCell('td', String(row.awardedPoints))
    );

    const answersCell = document.createElement('td');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const answers = document.createElement('pre');
    const evidenceText = JSON.stringify(row.evidence, null, 2);
    summary.textContent = Object.keys(row.evidence).length ? 'Ver respuestas' : 'Sin respuestas guardadas';
    answers.textContent = Object.keys(row.evidence).length ? evidenceText : '';
    details.append(summary, answers);
    answersCell.append(details);
    tableRow.append(answersCell);
    fragment.append(tableRow);
  });
  rowsContainer.replaceChildren(fragment);
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv() {
  const columns = [
    'Estudiante',
    'Grado',
    'Reto',
    'Estado',
    'Fases completadas',
    'Puntos del reto',
    'Respuestas guardadas (JSON)'
  ];
  const lines = [
    columns.map(csvCell).join(','),
    ...reportRows.map((row) => [
      row.student,
      row.grade,
      row.mission,
      row.status,
      row.completedPhases,
      row.awardedPoints,
      JSON.stringify(row.evidence)
    ].map(csvCell).join(','))
  ];
  const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `progreso-estudiantes-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  downloadButton.disabled = true;
  statusMessage.textContent = 'Consultando el progreso...';
  statusMessage.dataset.error = 'false';
  resultsSection.hidden = true;
  reportRows = [];
  rowsContainer.replaceChildren();

  try {
    const response = await fetch('/.netlify/functions/student-report', {
      headers: { Authorization: `Bearer ${tokenInput.value}` },
      cache: 'no-store'
    });
    if (response.status === 401) throw new Error('La clave docente no es válida.');
    if (response.status === 503) throw new Error('El panel aún no está configurado en Netlify.');
    if (!response.ok) throw new Error('No se pudo consultar el progreso. Intenta de nuevo más tarde.');
    const result = await response.json();
    if (!Array.isArray(result.students)) throw new Error('La respuesta del informe no tiene un formato válido.');

    reportRows = createReportRows(result.students);
    renderRows(reportRows);
    studentCount.textContent = `${result.students.length} estudiantes; ${reportRows.length} filas de progreso.`;
    resultsSection.hidden = false;
    downloadButton.disabled = reportRows.length === 0;
    statusMessage.textContent = result.students.length
      ? 'Informe cargado. Las respuestas visibles son las que cada actividad guardó.'
      : 'No se encontraron cuentas de estudiantes con perfiles.';
  } catch (error) {
    statusMessage.textContent = error instanceof Error
      ? error.message
      : 'No se pudo consultar el progreso. Intenta de nuevo.';
    statusMessage.dataset.error = 'true';
  } finally {
    tokenInput.value = '';
    submitButton.disabled = false;
  }
});

downloadButton.addEventListener('click', downloadCsv);
