/* Express-based Alexa endpoint for Vercel (no AWS needed) */
const express = require('express');

const Alexa = require('ask-sdk-core');
const { ExpressAdapter } = require('ask-sdk-express-adapter');

const OPENAI_MODEL = 'gpt-4o-mini';

// ---- OpenAI call (keep fast & short) ----
async function askOpenAI(prompt, history = []) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Missing OPENAI_API_KEY');

  const messages = [
    { role: 'system', content: 'You are Dora, a concise, friendly Alexa voice assistant. Keep answers under ~60 words unless asked for detail.' },
    ...history,
    { role: 'user', content: prompt }
  ];

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000); // Alexa end-to-end ~8s

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature: 0.3, max_tokens: 180 }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  } finally {
    clearTimeout(t);
  }
}

// ---- APL helpers (for Echo Show) ----
function supportsAPL(h) {
  return !!h.requestEnvelope.context?.System?.device?.supportedInterfaces?.['Alexa.Presentation.APL'];
}
function renderAPL(prompt, answer) {
  return {
    type: 'Alexa.Presentation.APL.RenderDocument',
    token: 'screen',
    document: {
      type: 'APL', version: '1.7',
      mainTemplate: {
        parameters: ['payload'],
        items: [{
          type: 'Container', paddingLeft: '24dp', paddingTop: '24dp',
          items: [
            { type: 'Text', text: 'Dora', fontSize: '36dp', fontWeight: '700' },
            { type: 'Text', text: 'You said:', fontSize: '22dp', color: '#888' },
            { type: 'Text', text: '${payload.prompt}', fontSize: '28dp', wrap: true },
            { type: 'Text', text: 'Dora:', fontSize: '22dp', color: '#888', spacing: '16dp' },
            { type: 'Text', text: '${payload.answer}', fontSize: '30dp', wrap: true }
          ]
        }]
      }
    },
    datasources: { payload: { prompt, answer } }
  };
}

// ---- Alexa handlers ----
const LaunchRequestHandler = {
  canHandle(h){ return h.requestEnvelope.request.type === 'LaunchRequest'; },
  handle(h){ return h.responseBuilder.speak("Hi, I'm Dora. Ask me anything.").reprompt("What should we talk about?").getResponse(); }
};

const FreeFormIntentHandler = {
  canHandle(h){
    const r = h.requestEnvelope.request;
    return r.type === 'IntentRequest' && r.intent.name === 'FreeFormIntent';
  },
  async handle(h){
    const slots = h.requestEnvelope.request.intent.slots || {};
    const userText = (slots.q?.value) || (slots.dora?.value) || 'hello';

    // Keep it quick (we're not doing progressive response on HTTPS yet)
    const attrs = h.attributesManager.getSessionAttributes();
    const history = (attrs.history || []).slice(-2);

    let answer;
    try { answer = await askOpenAI(userText, history); }
    catch(e){ console.log('OpenAI error:', e.message); answer = "Sorry, I couldn’t reach the assistant right now."; }

    attrs.history = [...(attrs.history || []), { role:'user', content:userText }, { role:'assistant', content:answer }];
    h.attributesManager.setSessionAttributes(attrs);

    const rb = h.responseBuilder.speak(answer).reprompt("What next?");
    if (supportsAPL(h)) rb.addDirective(renderAPL(userText, answer));
    return rb.getResponse();
  }
};

const ErrorHandler = {
  canHandle(){ return true; },
  handle(h, e){ console.log('Error:', e.stack || e); return h.responseBuilder.speak("Sorry, something went wrong.").getResponse(); }
};

// ---- Build Alexa skill & Express adapter (does signature+timestamp verification) ----
const skill = Alexa.SkillBuilders.custom()
  .withApiClient(new Alexa.DefaultApiClient())
  .addRequestHandlers(LaunchRequestHandler, FreeFormIntentHandler)
  .addErrorHandlers(ErrorHandler)
  .create();

// const adapter = new ExpressAdapter(skill, true, true); // verification enabled
const adapter = new ExpressAdapter(skill, false, false); // TEMP: verification OFF (we'll turn back on later)

const app = express();
app.head('/', (req, res) => res.status(200).end());
app.get('/',  (req, res) => res.status(200).send('OK — Alexa endpoint is at POST /'));

app.get('/', (req, res) => res.status(200).send('OK — Alexa endpoint is at POST /'));
// Do NOT add body parsers; adapter registers its own
//app.post('/', adapter.getRequestHandlers());
app.post('/', (req, res, next) => {
  console.log('[HIT] POST / at', new Date().toISOString());
  next();
}, adapter.getRequestHandlers());

// Vercel expects the Express app directly:
module.exports = app;
