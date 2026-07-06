// ===== Storage helpers =====
const LS_KEY_API = 'resume_app_api_key';
const LS_KEY_RESUME = 'resume_app_base_resume';
const LS_KEY_PROVIDER = 'resume_app_provider';
const LS_KEY_USAGE = 'resume_app_usage';

function getApiKey() { return localStorage.getItem(LS_KEY_API) || ''; }
function setApiKey(k) { localStorage.setItem(LS_KEY_API, k); }
function getBaseResume() { return localStorage.getItem(LS_KEY_RESUME) || ''; }
function setBaseResume(r) { localStorage.setItem(LS_KEY_RESUME, r); }
function getProvider() { return localStorage.getItem(LS_KEY_PROVIDER) || 'claude'; }
function setProvider(p) { localStorage.setItem(LS_KEY_PROVIDER, p); }

// Usage tracking
function getUsage() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY_USAGE) || '{"totalInputTokens":0,"totalOutputTokens":0,"totalCost":0,"calls":0}');
  } catch (e) {
    return { totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0, calls: 0 };
  }
}

function saveUsage(usage) {
  localStorage.setItem(LS_KEY_USAGE, JSON.stringify(usage));
}

function addUsage(inputTokens, outputTokens, provider) {
  const usage = getUsage();
  usage.totalInputTokens += inputTokens;
  usage.totalOutputTokens += outputTokens;
  usage.calls += 1;
  
  // Calculate cost based on provider
  const cost = calculateCost(inputTokens, outputTokens, provider);
  usage.totalCost += cost;
  
  saveUsage(usage);
  updateUsageDisplay();
  
  return cost;
}

function calculateCost(inputTokens, outputTokens, provider) {
  // Pricing per million tokens (as of 2024)
  const pricing = {
    claude: {
      input: 3.00,   // $3 per million input tokens (Claude 3.5 Sonnet)
      output: 15.00  // $15 per million output tokens
    },
    gemini: {
      input: 0.075,  // $0.075 per million input tokens (Gemini 2.0 Flash)
      output: 0.30   // $0.30 per million output tokens
    }
  };
  
  const rates = pricing[provider] || pricing.claude;
  const inputCost = (inputTokens / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;
  
  return inputCost + outputCost;
}

function formatCost(cost) {
  if (cost < 0.01) return '$' + cost.toFixed(4);
  if (cost < 1) return '$' + cost.toFixed(3);
  return '$' + cost.toFixed(2);
}

function updateUsageDisplay() {
  const usage = getUsage();
  const costEl = document.getElementById('usage-cost');
  const tokensEl = document.getElementById('usage-tokens');
  const callsEl = document.getElementById('usage-calls');
  
  if (costEl) costEl.textContent = formatCost(usage.totalCost);
  if (tokensEl) tokensEl.textContent = usage.totalInputTokens.toLocaleString() + ' in / ' + usage.totalOutputTokens.toLocaleString() + ' out';
  if (callsEl) callsEl.textContent = usage.calls;
}

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
  
  // Track usage
  if (data.usage) {
    addUsage(data.usage.input_tokens || 0, data.usage.output_tokens || 0, 'claude');
  }
  
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
        maxOutputTokens: maxTokens || 8000,
        temperature: 0.7
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
  console.log('Gemini raw response:', data);
  
  // Track usage
  if (data.usageMetadata) {
    addUsage(
      data.usageMetadata.promptTokenCount || 0,
      data.usageMetadata.candidatesTokenCount || 0,
      'gemini'
    );
  }
  
  // Handle different response formats
  if (data.candidates && data.candidates[0]) {
    const candidate = data.candidates[0];
    
    // Check for safety blocking
    if (candidate.finishReason === 'SAFETY') {
      throw new Error('Response was blocked by safety filters. Try rephrasing your input.');
    }
    
    // Check for content
    if (candidate.content && candidate.content.parts) {
      const text = candidate.content.parts.map(p => p.text || '').join('');
      if (text) return text;
    }
    
    // MAX_TOKENS - response was truncated
    if (candidate.finishReason === 'MAX_TOKENS') {
      // Try to get whatever text we have
      if (candidate.content && candidate.content.parts) {
        const partialText = candidate.content.parts.map(p => p.text || '').join('');
        if (partialText) return partialText;
      }
      throw new Error('Response was cut off due to length. Please try with a shorter job description or resume.');
    }
  }
  
  // If we got a response but in unexpected format
  console.log('Unexpected Gemini response format:', JSON.stringify(data, null, 2));
  throw new Error('Unexpected response from Gemini API. Please try again.');
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
  if (!raw || raw.trim().length === 0) {
    throw new Error('Empty response from AI. Please try again.');
  }
  
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
    console.log('JSON parse error:', e);
    console.log('Attempting to fix JSON...');
    
    // Try multiple fix strategies
    const fixes = [
      // Fix 1: Find last complete key-value pair
      () => {
        const lastComplete = jsonStr.lastIndexOf('",');
        if (lastComplete > 0) {
          return jsonStr.substring(0, lastComplete + 2) + '}';
        }
        return null;
      },
      // Fix 2: Find last closing brace
      () => {
        const lastBrace = jsonStr.lastIndexOf('}');
        if (lastBrace > 0) {
          return jsonStr.substring(0, lastBrace + 1);
        }
        return null;
      },
      // Fix 3: Try to close any open strings
      () => {
        let fixed = jsonStr;
        // Count open and close quotes
        const openQuotes = (fixed.match(/"/g) || []).length;
        if (openQuotes % 2 !== 0) {
          fixed = fixed + '"';
        }
        // Try to close any open braces
        const openBraces = (fixed.match(/{/g) || []).length;
        const closeBraces = (fixed.match(/}/g) || []).length;
        for (let i = 0; i < openBraces - closeBraces; i++) {
          fixed = fixed + '}';
        }
        return fixed;
      },
      // Fix 4: Extract just the score and note if we can
      () => {
        const scoreMatch = jsonStr.match(/"score"\s*:\s*(\d+)/);
        const noteMatch = jsonStr.match(/"score_note"\s*:\s*"([^"]*)"/);
        if (scoreMatch) {
          return JSON.stringify({
            score: parseInt(scoreMatch[1]),
            score_note: noteMatch ? noteMatch[1] : 'Analysis complete',
            matched_keywords: [],
            missing_keywords: [],
            needs_clarification: false,
            questions: [],
            alignment_warning: '',
            customized_resume: 'Unable to generate full resume. The response was truncated.',
            change_summary: 'Response was truncated during generation.'
          });
        }
        return null;
      }
    ];
    
    for (const fix of fixes) {
      try {
        const fixed = fix();
        if (fixed) {
          const parsed = JSON.parse(fixed);
          console.log('Successfully fixed JSON');
          return parsed;
        }
      } catch (e2) {
        // Continue to next fix
      }
    }
    
    console.log('All JSON fixes failed. Raw response:', raw);
    throw new Error('Could not parse AI response. The job description may be too long. Please try with a shorter one (under 5000 characters).');
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

// Reset usage stats
document.getElementById('reset-usage-btn').addEventListener('click', () => {
  if (confirm('Reset all usage statistics?')) {
    localStorage.removeItem(LS_KEY_USAGE);
    updateUsageDisplay();
  }
});

// Initialize usage display
updateUsageDisplay();

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

// Initialize Quill rich text editor
const quill = new Quill('#resume-editor', {
  theme: 'snow',
  placeholder: 'Paste your resume here or upload a file...',
  modules: {
    toolbar: [
      [{ 'header': [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ 'list': 'ordered'}, { 'list': 'bullet' }],
      [{ 'indent': '-1'}, { 'indent': '+1' }],
      ['link'],
      ['clean']
    ]
  }
});

// Load saved resume into Quill
const savedResume = getBaseResume();
if (savedResume) {
  // Convert plain text to HTML for Quill
  const htmlResume = savedResume.replace(/\n/g, '<br>');
  quill.root.innerHTML = htmlResume;
}

// Auto-save resume every 5 seconds
setInterval(() => {
  const currentText = quill.getText().trim();
  const savedText = getBaseResume();
  if (currentText !== savedText) {
    // Save as HTML to preserve formatting
    setBaseResume(quill.root.innerHTML);
  }
}, 5000);

// Also save on blur
quill.on('text-change', () => {
  // Debounced save will handle this
});

// Save button
saveResumeBtn.addEventListener('click', () => {
  setBaseResume(quill.root.innerHTML);
  saveConfirm.style.display = 'inline';
  setTimeout(() => saveConfirm.style.display = 'none', 2000);
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
    let html = '';
    let text = '';
    
    if (extension === 'txt') {
      // Plain text file
      text = await file.text();
      html = text.replace(/\n/g, '<br>');
    } else if (extension === 'docx') {
      // Word document - preserve formatting
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer });
      html = result.value;
      text = await file.text();
    } else if (extension === 'doc') {
      // Old Word format
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer });
      html = result.value;
      if (!html) {
        throw new Error('Could not read .doc file. Please save it as .docx or .txt and try again.');
      }
    } else if (extension === 'pdf') {
      // PDF file - extract text
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
      html = text.replace(/\n/g, '<br>');
    } else {
      throw new Error('Unsupported file type. Please use .txt, .doc, .docx, or .pdf');
    }
    
    if (!html && !text) {
      throw new Error('Could not extract content from the file. The file may be empty or contain only images.');
    }
    
    // Set the content in Quill
    quill.root.innerHTML = html || text.replace(/\n/g, '<br>');
    
    // Save immediately
    setBaseResume(quill.root.innerHTML);
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
  
  // Add info for long job descriptions
  if (n > 4000) {
    charCount.textContent += ' (will be processed in chunks)';
    charCount.style.color = '#1d4d8f';
  } else if (n > 3000) {
    charCount.textContent += ' (long description)';
    charCount.style.color = '#7a5000';
  } else {
    charCount.style.color = '';
  }
  
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
  const resumeHtml = getBaseResume().trim();
  showErr(errorBox, '');
  if (!resumeHtml) { showErr(errorBox, 'Please add your resume first in the "My Resume" tab.'); return; }
  if (!jd) { showErr(errorBox, 'Please paste a job description first.'); return; }
  currentJD = jd;
  
  // Strip HTML tags for the AI
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = resumeHtml;
  const resume = tempDiv.textContent || tempDiv.innerText || '';
  
  setAnalyzeLoading('Analyzing job description and matching keywords...');

  try {
    let data;
    
    // If job description is long, process in chunks
    if (jd.length > 4000) {
      data = await analyzeInChunks(jd, resume);
    } else {
      // Short job description - process normally
      const system = `You are an expert ATS resume optimizer and senior recruiter. Here is the candidate's base resume:\n\n${resume}\n\nAnalyze the job description the user provides. Score ATS alignment, identify matched/missing keywords, and rewrite the resume tailored to this specific job — reordering and rewording bullets to surface the most relevant experience and inject matching keywords naturally, without fabricating anything not supported by the base resume. If the alignment score is below 55, set needs_clarification to true and ask 2-4 specific clarifying questions about experience gaps before finalizing the rewrite (but still provide your best-effort customized_resume).\n\n${ANALYZE_SCHEMA_INSTRUCTIONS}`;
      
      setAnalyzeLoading('Analyzing job description...');
      const raw = await callAI(system, 'Job description:\n\n' + jd, 8000);
      data = parseJSON(raw);
    }
    
    renderResults(data);
  } catch (e) {
    viewLoading.style.display = 'none';
    viewInput.style.display = 'block';
    showErr(errorBox, 'Something went wrong: ' + e.message);
  }
});

// Analyze long job descriptions in chunks
async function analyzeInChunks(jd, resume) {
  const chunkSize = 3500; // Characters per chunk
  const chunks = [];
  
  // Split by paragraphs first, then by chunk size
  const paragraphs = jd.split(/\n\s*\n/);
  let currentChunk = '';
  
  for (const para of paragraphs) {
    if (currentChunk.length + para.length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = para;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }
  if (currentChunk) chunks.push(currentChunk);
  
  // If still too large, split by sentences
  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.length > chunkSize) {
      const sentences = chunk.split(/(?<=[.!?])\s+/);
      let subChunk = '';
      for (const sent of sentences) {
        if (subChunk.length + sent.length > chunkSize && subChunk.length > 0) {
          finalChunks.push(subChunk);
          subChunk = sent;
        } else {
          subChunk += (subChunk ? ' ' : '') + sent;
        }
      }
      if (subChunk) finalChunks.push(subChunk);
    } else {
      finalChunks.push(chunk);
    }
  }
  
  setAnalyzeLoading(`Processing ${finalChunks.length} sections of job description...`);
  
  // Analyze each chunk
  const allKeywords = { matched: [], missing: [] };
  let totalScore = 0;
  let chunkCount = 0;
  
  for (let i = 0; i < finalChunks.length; i++) {
    setAnalyzeLoading(`Analyzing section ${i + 1} of ${finalChunks.length}...`);
    
    const system = `You are an expert ATS keyword analyzer. Extract keywords from this job description section and match them against the resume. Return ONLY a JSON object with this exact format:
{
  "matched_keywords": ["keyword1", "keyword2"],
  "missing_keywords": ["keyword1", "keyword2"],
  "score": <integer 0-100 based on how well resume matches this section>
}

Resume:
${resume}

Job description section ${i + 1} of ${finalChunks.length}:`;
    
    try {
      const raw = await callAI(system, finalChunks[i], 2000);
      const chunkResult = parseJSON(raw);
      
      if (chunkResult.matched_keywords) allKeywords.matched.push(...chunkResult.matched_keywords);
      if (chunkResult.missing_keywords) allKeywords.missing.push(...chunkResult.missing_keywords);
      if (chunkResult.score) {
        totalScore += chunkResult.score;
        chunkCount++;
      }
    } catch (e) {
      console.log(`Chunk ${i + 1} failed:`, e);
      // Continue with other chunks
    }
  }
  
  // Deduplicate keywords
  allKeywords.matched = [...new Set(allKeywords.matched)];
  allKeywords.missing = [...new Set(allKeywords.missing)];
  
  // Remove keywords that appear in both (they're matched)
  allKeywords.missing = allKeywords.missing.filter(k => !allKeywords.matched.includes(k));
  
  const avgScore = chunkCount > 0 ? Math.round(totalScore / chunkCount) : 50;
  
  setAnalyzeLoading('Generating customized resume...');
  
  // Now generate the full resume with all keywords
  const generateSystem = `You are an expert ATS resume optimizer. Here is the candidate's base resume:\n\n${resume}\n\nAnalyze the COMPLETE job description below and rewrite the resume tailored to this specific job. Use the following pre-analyzed keywords to guide your optimization:

MATCHED KEYWORDS (already in resume): ${allKeywords.matched.join(', ')}
MISSING KEYWORDS (need to be added): ${allKeywords.missing.join(', ')}
OVERALL ATS SCORE: ${avgScore}/100

Rewrite the resume to:
1. Emphasize experience related to the matched keywords
2. Naturally incorporate missing keywords where truthful
3. Reorder bullets to surface most relevant experience
4. Keep all claims truthful and supported by the base resume

${ANALYZE_SCHEMA_INSTRUCTIONS}`;

  const raw = await callAI(generateSystem, 'Complete job description:\n\n' + jd, 8000);
  const finalResult = parseJSON(raw);
  
  // Override with our calculated values
  finalResult.score = avgScore;
  finalResult.matched_keywords = allKeywords.matched;
  finalResult.missing_keywords = allKeywords.missing;
  
  return finalResult;
}

document.getElementById('regenerate-btn').addEventListener('click', async () => {
  const answers = document.getElementById('answers-input').value.trim();
  if (!answers) return;
  showErr(errorBox, '');
  
  // Strip HTML tags for the AI
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = getBaseResume();
  const resume = tempDiv.textContent || tempDiv.innerText || '';
  
  setAnalyzeLoading('Regenerating resume with your additional context...');

  const system = `You are an expert ATS resume optimizer. Here is the candidate's base resume:\n\n${resume}\n\nThe candidate previously got a job description and answered clarifying questions to address experience gaps. Use their answers to write a stronger, fully tailored resume. Keep all claims truthful and grounded in what the candidate actually said.\n\n${ANALYZE_SCHEMA_INSTRUCTIONS}`;

  try {
    const raw = await callAI(system, `Job description:\n${currentJD}\n\nCandidate's additional context:\n${answers}`, 8000);
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

  // Strip HTML tags for the AI
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = getBaseResume();
  const resume = tempDiv.textContent || tempDiv.innerText || '';
  
  const system = `You are an expert career writer. Here is the candidate's resume:\n\n${resume}\n\nWrite a compelling, specific, truthful cover letter (3-4 paragraphs) tailored to the job description provided. Reference concrete achievements from the resume that map to the role's requirements. Avoid generic filler. Do not fabricate experience not present in the resume. Output ONLY the cover letter text (no JSON, no markdown, no preamble) — start directly with the salutation.`;

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