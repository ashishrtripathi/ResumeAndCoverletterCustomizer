// ===== Storage helpers =====
const LS_KEY_API = 'resume_app_api_key';
const LS_KEY_RESUME = 'resume_app_base_resume';
const LS_KEY_PROVIDER = 'resume_app_provider';

function getApiKey() { return localStorage.getItem(LS_KEY_API) || ''; }
function setApiKey(k) { localStorage.setItem(LS_KEY_API, k); }
function getBaseResume() { return localStorage.getItem(LS_KEY_RESUME) || DEFAULT_RESUME; }
function setBaseResume(r) { localStorage.setItem(LS_KEY_RESUME, r); }
function getProvider() { return localStorage.getItem(LS_KEY_PROVIDER) || 'claude'; }
function setProvider(p) { localStorage.setItem(LS_KEY_PROVIDER, p); }

// ===== API calls =====
async function callClaude(system, userMsg, maxTokens) {
  const key = getApiKey();
  if (!key) throw new Error('No API key set. Click the settings icon to add one.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens || 3000,
      system: system,
      messages: [{ role: 'user', content: userMsg }]
    })
  });

  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.error ? j.error.message : JSON.stringify(j); }
    catch (e) { detail = await res.text(); }
    if (res.status === 401) throw new Error('Invalid API key. Please check your key in settings.');
    if (res.status === 429) throw new Error('Rate limited by Anthropic. Please wait a moment and try again.');
    throw new Error('API error (' + res.status + '): ' + detail);
  }

  const data = await res.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return text;
}

async function callGemini(system, userMsg, maxTokens) {
  const key = getApiKey();
  if (!key) throw new Error('No API key set. Click the settings icon to add one.');

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: userMsg }]
      }],
      systemInstruction: {
        parts: [{ text: system }]
      },
      generationConfig: {
        maxOutputTokens: maxTokens || 3000
      }
    })
  });

  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.error ? j.error.message : JSON.stringify(j); }
    catch (e) { detail = await res.text(); }
    if (res.status === 400) throw new Error('Invalid API key. Please check your key in settings.');
    if (res.status === 429) throw new Error('Rate limited by Google. Please wait a moment and try again.');
    throw new Error('API error (' + res.status + '): ' + detail);
  }

  const data = await res.json();
  
  // Handle different response formats
  if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
    const text = data.candidates[0].content.parts.map(p => p.text || '').join('');
    if (text) return text;
  }
  
  // Response with no text content but valid response (e.g. empty parts)
  if (data.candidates && data.candidates[0]) {
    const candidate = data.candidates[0];
    if (candidate.finishReason === 'MAX_TOKENS') {
      return ''; // Key is valid but response was truncated
    }
    if (candidate.finishReason === 'SAFETY') {
      throw new Error('Response was blocked by safety filters.');
    }
  }
  
  // If we got a response but in unexpected format, log it for debugging
  console.log('Gemini API response:', JSON.stringify(data, null, 2));
  throw new Error('Unexpected response format from Gemini API. Check console for details.');
}

async function callAI(system, userMsg, maxTokens) {
  const provider = getProvider();
  if (provider === 'gemini') {
    return await callGemini(system, userMsg, maxTokens);
  } else {
    return await callClaude(system, userMsg, maxTokens);
  }
}

function parseJSON(raw) {
  // Try to extract JSON from the response - handle markdown fences and other text
  let jsonStr = raw;
  
  // Try to find JSON block in markdown fences
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1];
  }
  
  // Try to find JSON object in the text
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }
  
  // Clean up the string
  jsonStr = jsonStr.trim();
  
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // If parsing fails, try to fix common issues
    console.log('JSON parse error, attempting to fix...', e);
    console.log('Raw response:', raw);
    
    // Try to find and fix truncated JSON
    try {
      // Find the last complete key-value pair
      const lastComplete = jsonStr.lastIndexOf('",');
      if (lastComplete > 0) {
        const fixed = jsonStr.substring(0, lastComplete + 2) + '}';
        return JSON.parse(fixed);
      }
    } catch (e2) {
      // Ignore
    }
    
    throw new Error('Failed to parse AI response. Please try again.');
  }
}

// ===== API key setup UI =====
const keySetup = document.getElementById('key-setup');
const appMain = document.getElementById('app-main');
const claudeApiKeyInput = document.getElementById('claude-api-key');
const geminiApiKeyInput = document.getElementById('gemini-api-key');
const saveClaudeKeyBtn = document.getElementById('save-claude-key-btn');
const saveGeminiKeyBtn = document.getElementById('save-gemini-key-btn');
const keyError = document.getElementById('key-error');
const settingsBtn = document.getElementById('settings-btn');
const claudeInput = document.getElementById('claude-input');
const geminiInput = document.getElementById('gemini-input');
const providerRadios = document.querySelectorAll('input[name="provider"]');

function showKeySetup() {
  keySetup.style.display = 'block';
  appMain.style.display = 'none';
  claudeApiKeyInput.value = getProvider() === 'claude' ? getApiKey() : '';
  geminiApiKeyInput.value = getProvider() === 'gemini' ? getApiKey() : '';
  
  // Set the correct radio button
  providerRadios.forEach(radio => {
    radio.checked = radio.value === getProvider();
  });
  
  updateProviderInputs();
}

function updateProviderInputs() {
  const provider = getProvider();
  if (provider === 'gemini') {
    claudeInput.style.display = 'none';
    geminiInput.style.display = 'block';
  } else {
    claudeInput.style.display = 'block';
    geminiInput.style.display = 'none';
  }
}

function showApp() {
  keySetup.style.display = 'none';
  appMain.style.display = 'block';
}

providerRadios.forEach(radio => {
  radio.addEventListener('change', (e) => {
    setProvider(e.target.value);
    updateProviderInputs();
    keyError.style.display = 'none';
  });
});

saveClaudeKeyBtn.addEventListener('click', async () => {
  const key = claudeApiKeyInput.value.trim();
  keyError.style.display = 'none';
  if (!key) { keyError.textContent = 'Please enter a key.'; keyError.style.display = 'block'; return; }
  saveClaudeKeyBtn.disabled = true;
  saveClaudeKeyBtn.textContent = 'Verifying...';
  try {
    setApiKey(key);
    setProvider('claude');
    await callClaude('Reply with the single word: OK', 'test', 10);
    showApp();
  } catch (e) {
    // If rate limited, still save the key - it might be valid but temporarily rate limited
    if (e.message.includes('Rate limited') || e.message.includes('429')) {
      setApiKey(key);
      setProvider('claude');
      showApp();
    } else {
      keyError.textContent = 'Could not verify key: ' + e.message;
      keyError.style.display = 'block';
    }
  } finally {
    saveClaudeKeyBtn.disabled = false;
    saveClaudeKeyBtn.textContent = 'Save key';
  }
});

saveGeminiKeyBtn.addEventListener('click', async () => {
  const key = geminiApiKeyInput.value.trim();
  keyError.style.display = 'none';
  if (!key) { keyError.textContent = 'Please enter a key.'; keyError.style.display = 'block'; return; }
  saveGeminiKeyBtn.disabled = true;
  saveGeminiKeyBtn.textContent = 'Verifying...';
  try {
    setApiKey(key);
    setProvider('gemini');
    await callGemini('Reply with the single word: OK', 'test', 100);
    showApp();
  } catch (e) {
    // If rate limited, still save the key - it might be valid but temporarily rate limited
    if (e.message.includes('Rate limited') || e.message.includes('429')) {
      setApiKey(key);
      setProvider('gemini');
      showApp();
    } else {
      keyError.textContent = 'Could not verify key: ' + e.message;
      keyError.style.display = 'block';
    }
  } finally {
    saveGeminiKeyBtn.disabled = false;
    saveGeminiKeyBtn.textContent = 'Save key';
  }
});

settingsBtn.addEventListener('click', showKeySetup);

if (getApiKey()) { showApp(); } else { showKeySetup(); }

// ===== Tabs =====
document.querySelectorAll('.tabs:not(.sub-tabs) > .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs:not(.sub-tabs) > .tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

document.querySelectorAll('.sub-tabs > .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sub-tabs > .tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.sub-panel').forEach(p => { p.classList.remove('active'); p.style.display = 'none'; });
    btn.classList.add('active');
    const panel = document.getElementById('sub-' + btn.dataset.subtab);
    panel.classList.add('active');
    panel.style.display = 'block';
  });
});

// ===== Profile tab =====
const resumeEdit = document.getElementById('resume-edit');
const saveResumeBtn = document.getElementById('save-resume-btn');
const saveConfirm = document.getElementById('save-confirm');
const uploadResumeBtn = document.getElementById('upload-resume-btn');
const resumeFileInput = document.getElementById('resume-file-input');

resumeEdit.value = getBaseResume();

// Auto-save resume every 5 seconds
setInterval(() => {
  const currentText = resumeEdit.value;
  const savedText = getBaseResume();
  if (currentText !== savedText) {
    setBaseResume(currentText);
  }
}, 5000);

// Also save on blur (when user clicks away from textarea)
resumeEdit.addEventListener('blur', () => {
  setBaseResume(resumeEdit.value);
});

// File upload handling
uploadResumeBtn.addEventListener('click', () => {
  resumeFileInput.click();
});

resumeFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const extension = file.name.split('.').pop().toLowerCase();
  
  try {
    let text = '';
    
    if (extension === 'txt') {
      // Plain text file
      text = await file.text();
    } else if (extension === 'docx') {
      // Word document
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      text = result.value;
    } else if (extension === 'doc') {
      // Old Word format - try mammoth anyway, may work for some files
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      text = result.value;
      if (!text) {
        throw new Error('Could not read .doc file. Please save it as .docx or .txt and try again.');
      }
    } else if (extension === 'pdf') {
      // PDF file
      const arrayBuffer = await file.arrayBuffer();
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const textParts = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map(item => item.str).join(' ');
        textParts.push(pageText);
      }
      text = textParts.join('\n\n');
    } else {
      throw new Error('Unsupported file type. Please use .txt, .doc, .docx, or .pdf');
    }
    
    if (!text || text.trim().length === 0) {
      throw new Error('Could not extract text from the file. The file may be empty or contain only images.');
    }
    
    resumeEdit.value = text;
    setBaseResume(text);
    saveConfirm.style.display = 'inline';
    setTimeout(() => saveConfirm.style.display = 'none', 2000);
  } catch (err) {
    alert('Error reading file: ' + err.message);
  }
  
  // Reset file input so same file can be selected again
  resumeFileInput.value = '';
});

saveResumeBtn.addEventListener('click', () => {
  setBaseResume(resumeEdit.value);
  saveConfirm.style.display = 'inline';
  setTimeout(() => saveConfirm.style.display = 'none', 2000);
});

// ===== Analyze & Customize tab =====
const jdInput = document.getElementById('jd-input');
const charCount = document.getElementById('char-count');
const analyzeBtn = document.getElementById('analyze-btn');
const errorBox = document.getElementById('error-box');
const viewInput = document.getElementById('view-input');
const viewLoading = document.getElementById('view-loading');
const loadingMsg = document.getElementById('loading-msg');
const viewResults = document.getElementById('view-results');
const resetBtn = document.getElementById('reset-btn');

let currentJD = '';

jdInput.addEventListener('input', () => {
  const n = jdInput.value.trim().length;
  charCount.textContent = n > 0 ? n + ' characters' : '';
  
  // Auto-copy job description to cover letter tab
  if (jdInput.value.trim()) {
    coverJdInput.value = jdInput.value;
    document.getElementById('cover-jd-note').style.display = 'block';
  }
});

function showErr(box, msg) {
  box.textContent = msg;
  box.style.display = msg ? 'block' : 'none';
}

function setAnalyzeLoading(msg) {
  viewInput.style.display = 'none';
  viewResults.style.display = 'none';
  viewLoading.style.display = 'flex';
  loadingMsg.textContent = msg;
}

const ANALYZE_SCHEMA_INSTRUCTIONS = `Respond ONLY with valid JSON, no markdown fences, no commentary:
{
  "score": <integer 0-100>,
  "score_note": "<one sentence explanation>",
  "matched_keywords": ["<keyword>", ...],
  "missing_keywords": ["<keyword>", ...],
  "needs_clarification": <true if score < 55, else false>,
  "questions": ["<question>", ...],
  "alignment_warning": "<short string explaining the gap, or empty string>",
  "customized_resume": "<full rewritten resume as plain text, use \\n for newlines>",
  "change_summary": "<plain text, one point per line, summarizing what changed and why>"
}`;

analyzeBtn.addEventListener('click', async () => {
  const jd = jdInput.value.trim();
  const resume = getBaseResume().trim();
  showErr(errorBox, '');
  if (!resume) { showErr(errorBox, 'Please add your resume first in the "My Resume" tab.'); return; }
  if (!jd) { showErr(errorBox, 'Please paste a job description first.'); return; }
  currentJD = jd;
  setAnalyzeLoading('Analyzing job description and matching keywords...');

  const system = `You are an expert ATS resume optimizer and senior recruiter. Here is the candidate's base resume:\n\n${getBaseResume()}\n\nAnalyze the job description the user provides. Score ATS alignment, identify matched/missing keywords, and rewrite the resume tailored to this specific job — reordering and rewording bullets to surface the most relevant experience and inject matching keywords naturally, without fabricating anything not supported by the base resume. If the alignment score is below 55, set needs_clarification to true and ask 2-4 specific clarifying questions about experience gaps before finalizing the rewrite (but still provide your best-effort customized_resume).\n\n${ANALYZE_SCHEMA_INSTRUCTIONS}`;

  try {
    const raw = await callAI(system, 'Job description:\n\n' + jd, 4000);
    const data = parseJSON(raw);
    renderResults(data);
  } catch (e) {
    viewLoading.style.display = 'none';
    viewInput.style.display = 'block';
    showErr(errorBox, 'Something went wrong: ' + e.message);
  }
});

document.getElementById('regenerate-btn').addEventListener('click', async () => {
  const answers = document.getElementById('answers-input').value.trim();
  if (!answers) return;
  showErr(errorBox, '');
  setAnalyzeLoading('Regenerating resume with your additional context...');

  const system = `You are an expert ATS resume optimizer. Here is the candidate's base resume:\n\n${getBaseResume()}\n\nThe candidate previously got a job description and answered clarifying questions to address experience gaps. Use their answers to write a stronger, fully tailored resume. Keep all claims truthful and grounded in what the candidate actually said.\n\n${ANALYZE_SCHEMA_INSTRUCTIONS}`;

  try {
    const raw = await callAI(system, `Job description:\n${currentJD}\n\nCandidate's additional context:\n${answers}`, 4000);
    const data = parseJSON(raw);
    renderResults(data);
  } catch (e) {
    viewLoading.style.display = 'none';
    viewResults.style.display = 'block';
    showErr(errorBox, 'Regeneration failed: ' + e.message);
  }
});

function renderResults(d) {
  viewLoading.style.display = 'none';
  viewResults.style.display = 'block';

  document.getElementById('score-num').textContent = d.score + '/100';
  const fill = document.getElementById('bar-fill');
  fill.style.width = d.score + '%';
  fill.className = 'bar-fill ' + (d.score >= 70 ? 'green' : d.score >= 50 ? 'amber' : 'red');
  document.getElementById('score-note').textContent = d.score_note || '';

  document.getElementById('matches').innerHTML = (d.matched_keywords || []).map(k => `<span class="badge match">${escapeHtml(k)}</span>`).join('');
  document.getElementById('misses').innerHTML = (d.missing_keywords || []).map(k => `<span class="badge miss">${escapeHtml(k)}</span>`).join('');

  const clarifyCard = document.getElementById('clarify-card');
  if (d.needs_clarification && d.questions && d.questions.length) {
    clarifyCard.style.display = 'block';
    document.getElementById('warn-box').innerHTML = d.alignment_warning ? `<div class="warn-box">${escapeHtml(d.alignment_warning)}</div>` : '';
    document.getElementById('q-list').innerHTML = d.questions.map(q => `<div class="q-card">${escapeHtml(q)}</div>`).join('');
  } else {
    clarifyCard.style.display = 'none';
  }

  document.getElementById('resume-out').textContent = d.customized_resume || '';
  document.getElementById('changes-out').innerHTML = (d.change_summary || '').split('\n').filter(Boolean).map(l => `<p>${escapeHtml(l)}</p>`).join('');

  // reset sub-tabs to resume view
  document.querySelectorAll('.sub-tabs > .tab').forEach(b => b.classList.remove('active'));
  document.querySelector('.sub-tabs > .tab[data-subtab="resume"]').classList.add('active');
  document.getElementById('sub-resume').classList.add('active');
  document.getElementById('sub-resume').style.display = 'block';
  document.getElementById('sub-changes').classList.remove('active');
  document.getElementById('sub-changes').style.display = 'none';
}

resetBtn.addEventListener('click', () => {
  viewResults.style.display = 'none';
  viewLoading.style.display = 'none';
  viewInput.style.display = 'block';
  jdInput.value = '';
  charCount.textContent = '';
  document.getElementById('answers-input').value = '';
  showErr(errorBox, '');
});

document.getElementById('copy-resume-btn').addEventListener('click', () => {
  const text = document.getElementById('resume-out').textContent;
  navigator.clipboard.writeText(text).then(() => flashBtnText('copy-resume-btn', 'Copied!'));
});

document.getElementById('download-resume-txt-btn').addEventListener('click', () => {
  downloadText(document.getElementById('resume-out').textContent, 'Tailored_Resume.txt');
});

document.getElementById('download-resume-pdf-btn').addEventListener('click', () => {
  downloadPDF(document.getElementById('resume-out').textContent, 'Tailored_Resume.pdf');
});

document.getElementById('download-resume-docx-btn').addEventListener('click', () => {
  downloadDOCX(document.getElementById('resume-out').textContent, 'Tailored_Resume.docx');
});

// ===== Cover Letter tab =====
const coverJdInput = document.getElementById('cover-jd-input');
const coverCompanyInput = document.getElementById('cover-company-input');
const coverNotesInput = document.getElementById('cover-notes-input');
const coverGenerateBtn = document.getElementById('cover-generate-btn');
const coverErrorBox = document.getElementById('cover-error-box');
const coverLoading = document.getElementById('cover-loading');
const coverResults = document.getElementById('cover-results');
const coverOut = document.getElementById('cover-out');

coverGenerateBtn.addEventListener('click', async () => {
  const jd = coverJdInput.value.trim() || currentJD;
  const company = coverCompanyInput.value.trim();
  const notes = coverNotesInput.value.trim();
  showErr(coverErrorBox, '');

  if (!jd) { showErr(coverErrorBox, 'Please paste a job description first.'); return; }

  coverResults.style.display = 'none';
  coverLoading.style.display = 'flex';

  const system = `You are an expert career writer. Here is the candidate's resume:\n\n${getBaseResume()}\n\nWrite a compelling, specific, truthful cover letter (3-4 paragraphs) tailored to the job description provided. Reference concrete achievements from the resume that map to the role's requirements. Avoid generic filler. Do not fabricate experience not present in the resume. Output ONLY the cover letter text (no JSON, no markdown, no preamble) — start directly with the salutation.`;

  let userMsg = 'Job description:\n\n' + jd;
  if (company) userMsg += '\n\nCompany name: ' + company;
  if (notes) userMsg += '\n\nThe candidate wants the letter to specifically emphasize: ' + notes;

  try {
    const raw = await callAI(system, userMsg, 3000);
    coverOut.textContent = raw.trim();
    coverLoading.style.display = 'none';
    coverResults.style.display = 'block';
  } catch (e) {
    coverLoading.style.display = 'none';
    showErr(coverErrorBox, 'Something went wrong: ' + e.message);
  }
});

document.getElementById('copy-cover-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(coverOut.textContent).then(() => flashBtnText('copy-cover-btn', 'Copied!'));
});

document.getElementById('download-cover-txt-btn').addEventListener('click', () => {
  downloadText(coverOut.textContent, 'Cover_Letter.txt');
});

document.getElementById('download-cover-pdf-btn').addEventListener('click', () => {
  downloadPDF(coverOut.textContent, 'Cover_Letter.pdf');
});

document.getElementById('download-cover-docx-btn').addEventListener('click', () => {
  downloadDOCX(coverOut.textContent, 'Cover_Letter.docx');
});

// ===== Utilities =====
function flashBtnText(id, msg) {
  const btn = document.getElementById(id);
  const original = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => btn.textContent = original, 1800);
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadPDF(text, filename) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  
  const lines = doc.splitTextToSize(text, 180);
  let y = 20;
  
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  
  for (const line of lines) {
    if (y > 270) {
      doc.addPage();
      y = 20;
    }
    doc.text(line, 15, y);
    y += 5;
  }
  
  doc.save(filename);
}

function downloadDOCX(text, filename) {
  const { Document, Packer, Paragraph, TextRun } = window.docx;
  
  const paragraphs = text.split('\n').map(line => {
    return new Paragraph({
      children: [
        new TextRun({
          text: line,
          font: 'Arial',
          size: 24, // 12pt
        }),
      ],
    });
  });
  
  const doc = new Document({
    sections: [{
      properties: {},
      children: paragraphs,
    }],
  });
  
  Packer.toBlob(doc).then(blob => {
    if (window.saveAs) {
      saveAs(blob, filename);
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}