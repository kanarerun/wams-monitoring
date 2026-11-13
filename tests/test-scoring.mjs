// Minimal harness for the WAMS monitoring-logs auto-scoring math.
// Mirrors buildAnswerItem() from wams-professor-monitoring-logs.js.
function buildAnswerItem(qtype, question, studentVal){
  const choices = Array.isArray(question.choices) ? question.choices : [];
  const correctIdx = question.correct != null ? question.correct : -1;
  if(qtype === 'mc'){
    const studentIdx = typeof studentVal === 'number' ? studentVal : parseInt(studentVal, 10);
    const isCorrect = studentIdx === correctIdx;
    return { type: 'mcq', correct: isCorrect };
  }
  if(qtype === 'cb'){
    const studentArr = Array.isArray(studentVal) ? studentVal : [];
    const correctArr = Array.isArray(question.correct) ? question.correct : [];
    const studentChoices = studentArr.map(i => choices[i]).filter(Boolean);
    const correctChoices = correctArr.map(i => choices[i]).filter(Boolean);
    const isCorrect = studentChoices.length === correctChoices.length && studentChoices.every(c => correctChoices.includes(c));
    return { type: 'checkbox', correct: isCorrect };
  }
  if(qtype === 'sa'){
    const studentText = String(studentVal || '').trim();
    const correctText = String(question.correct_answer || question.answer || '').trim();
    const isCorrect = correctText !== '' && studentText.toLowerCase() === correctText.toLowerCase();
    return { type: 'short', correct: isCorrect };
  }
  return { type: 'paragraph', correct: false };
}

function assert(name, cond){
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  if(!cond) process.exitCode = 1;
}

// Exam: 3 MC questions, correct answers at indices 2, 0, 1
const examQuestions = [
  { qtype: 'mc', choices: ['A1','A2','A3'], correct: 2 },
  { qtype: 'mc', choices: ['B1','B2','B3'], correct: 0 },
  { qtype: 'mc', choices: ['C1','C2','C3'], correct: 1 },
];

// Student picked 2, 0, 2 (two correct, one wrong)
const answers = { 0: 2, 1: 0, 2: 2 };
const built = Object.keys(answers).map(qIdx => {
  const qi = parseInt(qIdx, 10);
  const question = examQuestions[qi];
  if (!question) return null;
  return buildAnswerItem(question.qtype || 'mc', question, answers[qIdx]);
}).filter(Boolean);

const gradable = built.filter(a => a.type !== 'paragraph');
const correctCount = gradable.filter(a => a.correct).length;
assert('student with 2/3 correct scores 2', correctCount === 2);
assert('all answers are gradable (mc)', gradable.length === 3);

// Student answered with string keys (server JSON round-trip)
const answers2 = { '0': '2', '1': '0', '2': '1' };
const built2 = Object.keys(answers2).map(qIdx => {
  const qi = parseInt(qIdx, 10);
  const question = examQuestions[qi];
  if (!question) return null;
  return buildAnswerItem(question.qtype || 'mc', question, answers2[qIdx]);
}).filter(Boolean);
const gradable2 = built2.filter(a => a.type !== 'paragraph');
assert('string-keyed answers score 3/3', gradable2.filter(a => a.correct).length === 3);

// No answer recorded
const built3 = [buildAnswerItem('mc', examQuestions[0], undefined)];
assert('unanswered question scores 0', built3[0].correct === false);

// Checkbox exact-match
const cb = { qtype: 'cb', choices: ['X','Y','Z'], correct: [0, 2] };
assert('checkbox exact match correct', buildAnswerItem('cb', cb, [0, 2]).correct === true);
assert('checkbox partial match wrong', buildAnswerItem('cb', cb, [0]).correct === false);

// Empty question list (the race that was fixed) scores nothing
const noQuestions = [];
const built4 = Object.keys(answers).map(qIdx => {
  const qi = parseInt(qIdx, 10);
  const question = noQuestions[qi];
  if (!question) return null;
  return buildAnswerItem('mc', question, answers[qIdx]);
}).filter(Boolean);
assert('empty question list yields no answers (previously scored 0)', built4.length === 0);
