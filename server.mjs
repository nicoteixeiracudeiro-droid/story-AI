import { createServer } from "node:http";
import { createHmac, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL(".", import.meta.url));
loadLocalEnv();

const PORT = Number(process.env.PORT) || 5173;
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const STRIPE_API_URL = "https://api.stripe.com/v1";
const FREE_QUESTION_LIMIT = 5;
const SESSION_COOKIE = "studyai_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const PASSWORD_ITERATIONS = 120_000;
const DATA_DIR = join(ROOT_DIR, "data");
const DB_PATH = join(DATA_DIR, "studyai-db.json");
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;
const PREMIUM_PLANS = {
  monthly: {
    aliases: ["monthly", "1 month", "month"],
    description: "Unlimited StudyAI conversations for one month.",
    durationMonths: 1,
    name: "StudyAI Premium - 1 month",
    unitAmount: 1999,
  },
  term: {
    aliases: ["term", "5 months", "5 month", "school term"],
    description: "Unlimited StudyAI conversations for five months.",
    durationMonths: 5,
    name: "StudyAI Premium - 5 months",
    unitAmount: 8999,
  },
  annual: {
    aliases: ["annual", "year", "12 months", "12 month", "full year"],
    description: "Unlimited StudyAI conversations for twelve months.",
    durationMonths: 12,
    name: "StudyAI Premium - 12 months",
    unitAmount: 17999,
  },
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function loadLocalEnv() {
  const envPath = join(ROOT_DIR, ".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf8");
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) return;

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(data));
}

function readRequestBody(request, maxLength = 200_000) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxLength) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });

    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createEmptyDatabase() {
  return {
    users: [],
    sessions: [],
  };
}

function normalizeDatabase(data) {
  return {
    users: Array.isArray(data?.users) ? data.users : [],
    sessions: Array.isArray(data?.sessions) ? data.sessions : [],
  };
}

async function readDatabase() {
  try {
    const content = await readFile(DB_PATH, "utf8");
    return normalizeDatabase(JSON.parse(content));
  } catch (error) {
    if (error.code === "ENOENT") {
      return createEmptyDatabase();
    }

    throw error;
  }
}

async function writeDatabase(database) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DB_PATH, `${JSON.stringify(normalizeDatabase(database), null, 2)}\n`);
}

function getPlanById(planId) {
  const normalizedPlan = String(planId || "").trim().toLowerCase();

  return Object.entries(PREMIUM_PLANS).find(([, plan]) => plan.aliases.includes(normalizedPlan)) || null;
}

function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function getAppUrl(request) {
  const configuredUrl = process.env.APP_URL || process.env.SITE_URL;
  if (configuredUrl) return configuredUrl.replace(/\/$/, "");

  const protocol = request.headers["x-forwarded-proto"] || "http";
  return `${protocol}://${request.headers.host}`;
}

function isPremiumActive(user) {
  if (!user?.isPremium) return false;
  if (!user.premiumUntil) return true;
  return new Date(user.premiumUntil) > new Date();
}

function updateExpiredPremium(user) {
  if (user?.isPremium && user.premiumUntil && new Date(user.premiumUntil) <= new Date()) {
    user.isPremium = false;
    user.premiumPlan = null;
    user.updatedAt = new Date().toISOString();
  }
}

function hashPassword(password, salt = randomBytes(16).toString("hex"), iterations = PASSWORD_ITERATIONS) {
  return {
    hash: pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex"),
    iterations,
    salt,
  };
}

function verifyPassword(password, user) {
  if (!user.passwordHash || !user.passwordSalt || !user.passwordIterations) return false;

  const candidate = hashPassword(password, user.passwordSalt, user.passwordIterations).hash;
  const storedBuffer = Buffer.from(user.passwordHash, "hex");
  const candidateBuffer = Buffer.from(candidate, "hex");

  return storedBuffer.length === candidateBuffer.length && timingSafeEqual(storedBuffer, candidateBuffer);
}

function publicUser(user) {
  updateExpiredPremium(user);
  const questionsUsed = Number(user.questionsUsed) || 0;
  const isPremium = isPremiumActive(user);
  const questionsLeft = isPremium ? null : Math.max(FREE_QUESTION_LIMIT - questionsUsed, 0);

  return {
    id: user.id,
    email: user.email,
    isPremium,
    plan: isPremium ? user.premiumPlan || "premium" : "free",
    premiumUntil: isPremium ? user.premiumUntil || null : null,
    questionsUsed,
    questionsLeft,
  };
}

function parseCookies(request) {
  const cookieHeader = request.headers.cookie || "";

  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const equalsIndex = cookie.indexOf("=");
        if (equalsIndex === -1) return [cookie, ""];
        return [cookie.slice(0, equalsIndex), decodeURIComponent(cookie.slice(equalsIndex + 1))];
      })
  );
}

function createSessionCookie(sessionId) {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

async function getRequestContext(request) {
  const database = await readDatabase();
  const sessionId = parseCookies(request)[SESSION_COOKIE];
  const now = new Date();
  const activeSessions = database.sessions.filter((session) => new Date(session.expiresAt) > now);

  if (activeSessions.length !== database.sessions.length) {
    database.sessions = activeSessions;
    await writeDatabase(database);
  }

  const session = sessionId ? database.sessions.find((item) => item.id === sessionId) : null;
  const user = session ? database.users.find((item) => item.id === session.userId) : null;

  return {
    database,
    session,
    user,
  };
}

function createSession(database, userId) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  const session = {
    createdAt: now.toISOString(),
    expiresAt,
    id: randomUUID(),
    userId,
  };

  database.sessions.push(session);
  return session;
}

function formatNumber(number) {
  if (Number.isInteger(number)) return String(number);
  return Number(number.toFixed(3)).toString();
}

function createLesson({ topic, keyIdea, explanation, example, practice, nextStep }) {
  return `Topic: ${topic}

Key idea: ${keyIdea}

Explanation: ${explanation}

Example: ${example}

Practice: ${practice}

Next step: ${nextStep}`;
}

const STUDYAI_TUTOR_INSTRUCTIONS = `You are StudyAI, a premium AI study tutor for middle school, high school, and early college students.

Core goal:
Help the student understand the topic, not just copy an answer.

Quality rules:
- First decide what subject and task the student is asking about.
- If the question is vague or has typos, make the most reasonable interpretation, say it briefly, and still give useful help.
- If important information is missing, explain what is missing and ask one clear follow-up question at the end.
- Use the student's language when it is obvious. Otherwise answer in clear English.
- Keep explanations accurate, concrete, and student-friendly.
- Avoid generic filler. Every section should teach something useful.
- Do not invent facts, sources, quotes, formulas, or book details. If you are unsure, say what you would need to know.
- For math: show clean steps, define symbols, include units when relevant, and verify the answer with a quick check.
- For science: explain cause and effect, define key terms, and include a simple real-world example.
- For history/literature: give context, explain why it matters, and separate facts from interpretation.
- For writing: help plan, improve, and explain choices. Do not encourage plagiarism.
- If a student asks for cheating on a live test, refuse briefly and offer a study-safe explanation instead.

Default answer format:
Topic:
Quick answer:
Steps or explanation:
Example or check:
Practice:

Only add "Common mistake:" or "Next step:" when it is genuinely useful.

Style:
Sound like a sharp, calm teacher. Be clear, confident, and practical.
Keep answers compact: usually 90-180 words. Use longer answers only when the student asks for a full essay, long plan, or detailed revision guide.
Use plain text only. Do not use LaTeX delimiters like \\(...\\) or \\[...\\], markdown tables, or raw markdown formatting. Write equations in a readable plain-text style, like x = (20 - 5) / 3.`;

function buildTutorPrompt(question) {
  return `Student question:
${question}

Give the best tutoring answer you can.`;
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n\n").trim();
}

function parsePercentage(question) {
  const match = question.toLowerCase().match(/(\d+(?:\.\d+)?)\s*%\s*(?:of|de|von)\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const percent = Number(match[1]);
  const amount = Number(match[2]);
  if (!Number.isFinite(percent) || !Number.isFinite(amount)) return null;

  return {
    amount,
    percent,
    answer: (percent / 100) * amount,
  };
}

function parseLinearEquation(question) {
  const compactQuestion = question.toLowerCase().replace(/\s+/g, "");
  const equationMatch = compactQuestion.match(/([+-]?\d*x(?:[+-]\d+)?=-?\d+)/);
  if (!equationMatch) return null;

  const equation = equationMatch[1];
  const [leftSide, rightSide] = equation.split("=");
  const leftMatch = leftSide.match(/^([+-]?\d*)x([+-]\d+)?$/);
  if (!leftMatch) return null;

  const coefficientText = leftMatch[1];
  const constantText = leftMatch[2] || "0";
  const coefficient = coefficientText === "" || coefficientText === "+" ? 1 : coefficientText === "-" ? -1 : Number(coefficientText);
  const constant = Number(constantText);
  const result = Number(rightSide);

  if (!Number.isFinite(coefficient) || !Number.isFinite(constant) || !Number.isFinite(result) || coefficient === 0) {
    return null;
  }

  return {
    coefficient,
    constant,
    equation,
    result,
    solution: (result - constant) / coefficient,
  };
}

function fallbackStudyAnswer(question) {
  const lowerQuestion = question.toLowerCase();
  const parsedEquation = parseLinearEquation(question);
  const parsedPercentage = parsePercentage(question);

  if (parsedEquation) {
    const { coefficient, constant, equation, result, solution } = parsedEquation;
    const constantSign = constant >= 0 ? `+ ${formatNumber(constant)}` : `- ${formatNumber(Math.abs(constant))}`;
    const oppositeOperation = constant >= 0 ? `subtract ${formatNumber(constant)}` : `add ${formatNumber(Math.abs(constant))}`;
    const afterConstant = result - constant;

    return `Topic: solving a linear equation

Key idea: x is an unknown number. ${formatNumber(coefficient)}x means ${formatNumber(coefficient)} times x.

Equation:
${equation.replace("=", " = ")}

Step 1: remove the number next to the x term.
${formatNumber(coefficient)}x ${constantSign} = ${formatNumber(result)}
We ${oppositeOperation} on both sides.

Step 2: simplify.
${formatNumber(coefficient)}x = ${formatNumber(afterConstant)}

Step 3: divide by ${formatNumber(coefficient)}.
x = ${formatNumber(afterConstant)} / ${formatNumber(coefficient)}
x = ${formatNumber(solution)}

Check:
${formatNumber(coefficient)} x ${formatNumber(solution)} ${constantSign} = ${formatNumber(result)}

Practice: try another one like 4x + 2 = 18.

Next step: send another equation and StudyAI will solve it step by step.`;
  }

  if (parsedPercentage) {
    const { amount, percent, answer } = parsedPercentage;

    return `Topic: percentages

Key idea: percent means "out of 100." So ${formatNumber(percent)}% means ${formatNumber(percent)} out of 100.

Explanation:
To find ${formatNumber(percent)}% of ${formatNumber(amount)}, turn the percent into a decimal and multiply.

Step 1:
${formatNumber(percent)}% = ${formatNumber(percent)} / 100 = ${formatNumber(percent / 100)}

Step 2:
${formatNumber(percent / 100)} x ${formatNumber(amount)} = ${formatNumber(answer)}

Answer:
${formatNumber(percent)}% of ${formatNumber(amount)} is ${formatNumber(answer)}.

Practice: find 15% of 60.

Next step: ask another percentage question and StudyAI will show the steps.`;
  }

  if (lowerQuestion.includes("photosynthesis")) {
    return createLesson({
      topic: "photosynthesis",
      keyIdea: "Plants use light energy to make their own food.",
      explanation: "A plant takes in carbon dioxide from the air and water from the soil. With sunlight, it changes them into glucose, which is sugar the plant can use for energy. Oxygen is released as a leftover product.",
      example: "carbon dioxide + water + light -> glucose + oxygen.",
      practice: "Write one sentence explaining what the plant takes in, and one sentence explaining what it produces.",
      nextStep: "Ask for a 5-question quiz if you are preparing for a science test.",
    });
  }

  if (lowerQuestion.includes("essay") || lowerQuestion.includes("paragraph") || lowerQuestion.includes("thesis")) {
    return createLesson({
      topic: "essay writing",
      keyIdea: "A strong essay is built around one clear main argument.",
      explanation: "Start with your thesis, then make each paragraph prove one part of that thesis. A simple paragraph structure is point, evidence, explanation, and link back to the question.",
      example: "If the essay asks whether homework is useful, your thesis could be: Homework is useful when it helps students practice skills they already learned in class.",
      practice: "Write one thesis sentence, then list three paragraph points that would support it.",
      nextStep: "Send your essay question and StudyAI will help you build a plan.",
    });
  }

  return createLesson({
    topic: question,
    keyIdea: "Most confusing topics become easier when we break them into small parts.",
    explanation: "First, find the important words. Next, ask what each word means. Then connect the ideas in order. This turns the topic from something to memorize into something you can explain.",
    example: "If the topic is volcanoes, learn what magma is, why pressure builds up, what an eruption is, and what happens after.",
    practice: "Write the topic as one question beginning with How or Why.",
    nextStep: "Add OPENAI_API_KEY in .env when you are ready for real AI answers through this backend.",
  });
}

async function getOpenAIStudyAnswer(question) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      answer: fallbackStudyAnswer(question),
      source: "fallback",
    };
  }

  const model = process.env.OPENAI_MODEL || "gpt-5.2";
  const openaiResponse = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      instructions: STUDYAI_TUTOR_INSTRUCTIONS,
      input: buildTutorPrompt(question),
      max_output_tokens: 650,
      model,
      reasoning: {
        effort: "none",
      },
      text: {
        format: {
          type: "text",
        },
      },
    }),
  });

  if (!openaiResponse.ok) {
    const details = await openaiResponse.text();
    throw new Error(`OpenAI request failed: ${openaiResponse.status} ${details}`);
  }

  const data = await openaiResponse.json();
  const answer = extractOpenAIText(data) || fallbackStudyAnswer(question);

  return {
    answer,
    source: "openai",
  };
}

function assertStripeConfigured() {
  if (!process.env.STRIPE_SECRET_KEY) {
    const error = new Error("Stripe is not connected yet. Add STRIPE_SECRET_KEY in .env first.");
    error.statusCode = 503;
    throw error;
  }
}

async function stripeRequest(path, { method = "GET", params } = {}) {
  assertStripeConfigured();

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
    },
  };

  if (params) {
    options.headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = new URLSearchParams(params);
  }

  const stripeResponse = await fetch(`${STRIPE_API_URL}${path}`, options);
  const data = await stripeResponse.json().catch(() => ({}));

  if (!stripeResponse.ok) {
    const error = new Error(data.error?.message || "Stripe request failed.");
    error.statusCode = stripeResponse.status;
    error.stripeError = data.error;
    throw error;
  }

  return data;
}

async function createCheckoutSession({ planId, request, user }) {
  const planEntry = getPlanById(planId);

  if (!planEntry) {
    const error = new Error("Choose a valid premium plan.");
    error.statusCode = 400;
    throw error;
  }

  const [resolvedPlanId, plan] = planEntry;
  const appUrl = getAppUrl(request);
  const successUrl = `${appUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}#chat`;
  const cancelUrl = `${appUrl}/?checkout=cancel#plans`;

  return stripeRequest("/checkout/sessions", {
    method: "POST",
    params: {
      "allow_promotion_codes": "true",
      "billing_address_collection": "auto",
      "cancel_url": cancelUrl,
      "client_reference_id": user.id,
      "customer_email": user.email,
      "line_items[0][price_data][currency]": "chf",
      "line_items[0][price_data][product_data][description]": plan.description,
      "line_items[0][price_data][product_data][name]": plan.name,
      "line_items[0][price_data][unit_amount]": String(plan.unitAmount),
      "line_items[0][quantity]": "1",
      "metadata[planId]": resolvedPlanId,
      "metadata[userId]": user.id,
      "mode": "payment",
      "payment_intent_data[metadata][planId]": resolvedPlanId,
      "payment_intent_data[metadata][userId]": user.id,
      "payment_method_types[0]": "card",
      "success_url": successUrl,
    },
  });
}

function parseStripeSignature(signatureHeader) {
  return Object.fromEntries(
    String(signatureHeader || "")
      .split(",")
      .map((part) => part.split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, value])
  );
}

function verifyStripeWebhookSignature(rawBody, signatureHeader) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    const error = new Error("Stripe webhook secret is not configured.");
    error.statusCode = 503;
    throw error;
  }

  const parsedSignature = parseStripeSignature(signatureHeader);
  const timestamp = Number(parsedSignature.t);
  const stripeSignature = parsedSignature.v1;

  if (!timestamp || !stripeSignature) {
    const error = new Error("Stripe webhook signature is missing.");
    error.statusCode = 400;
    throw error;
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
  if (ageSeconds > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    const error = new Error("Stripe webhook signature is too old.");
    error.statusCode = 400;
    throw error;
  }

  const expectedSignature = createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  const stripeBuffer = Buffer.from(stripeSignature, "hex");

  if (expectedBuffer.length !== stripeBuffer.length || !timingSafeEqual(expectedBuffer, stripeBuffer)) {
    const error = new Error("Stripe webhook signature is invalid.");
    error.statusCode = 400;
    throw error;
  }
}

async function retrieveCheckoutSession(sessionId) {
  return stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

function activatePremiumFromSession(database, session) {
  if (session.payment_status !== "paid") {
    return {
      activated: false,
      reason: "Payment is not marked as paid yet.",
      user: null,
    };
  }

  const userId = session.client_reference_id || session.metadata?.userId;
  const user = database.users.find((item) => item.id === userId);

  if (!user) {
    return {
      activated: false,
      reason: "User was not found for this Stripe session.",
      user: null,
    };
  }

  user.processedStripeSessions = Array.isArray(user.processedStripeSessions) ? user.processedStripeSessions : [];

  if (user.processedStripeSessions.includes(session.id)) {
    return {
      activated: false,
      reason: "This Stripe session was already processed.",
      user,
    };
  }

  const planEntry = getPlanById(session.metadata?.planId);
  if (!planEntry) {
    return {
      activated: false,
      reason: "Stripe session has no valid plan.",
      user,
    };
  }

  const [planId, plan] = planEntry;
  const now = new Date();
  const currentPremiumUntil = user.premiumUntil ? new Date(user.premiumUntil) : null;
  const baseDate = currentPremiumUntil && currentPremiumUntil > now ? currentPremiumUntil : now;

  user.isPremium = true;
  user.lastStripeCheckoutSessionId = session.id;
  user.premiumActivatedAt = now.toISOString();
  user.premiumPlan = planId;
  user.premiumUntil = addMonths(baseDate, plan.durationMonths).toISOString();
  user.questionsUsed = 0;
  user.stripeCustomerId = session.customer || user.stripeCustomerId || null;
  user.updatedAt = now.toISOString();
  user.processedStripeSessions = [...user.processedStripeSessions, session.id].slice(-20);

  return {
    activated: true,
    reason: "Premium activated.",
    user,
  };
}

async function readJsonPayload(request) {
  const body = await readRequestBody(request);
  return JSON.parse(body || "{}");
}

async function handleSignupRequest(request, response) {
  try {
    const payload = await readJsonPayload(request);
    const email = normalizeEmail(payload.email);
    const password = String(payload.password || "");

    if (!isValidEmail(email)) {
      sendJson(response, 400, { error: "Use a real email address." });
      return;
    }

    if (password.length < 6) {
      sendJson(response, 400, { error: "Password must be at least 6 characters." });
      return;
    }

    const database = await readDatabase();
    const existingUser = database.users.find((user) => user.email === email);

    if (existingUser) {
      sendJson(response, 409, { error: "This account already exists. Log in instead." });
      return;
    }

    const passwordData = hashPassword(password);
    const now = new Date().toISOString();
    const user = {
      createdAt: now,
      email,
      id: randomUUID(),
      isPremium: false,
      passwordHash: passwordData.hash,
      passwordIterations: passwordData.iterations,
      passwordSalt: passwordData.salt,
      premiumPlan: null,
      questionsUsed: 0,
      updatedAt: now,
    };

    database.users.push(user);
    const session = createSession(database, user.id);
    await writeDatabase(database);

    sendJson(response, 201, { user: publicUser(user) }, { "Set-Cookie": createSessionCookie(session.id) });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Could not create account right now." });
  }
}

async function handleLoginRequest(request, response) {
  try {
    const payload = await readJsonPayload(request);
    const email = normalizeEmail(payload.email);
    const password = String(payload.password || "");
    const database = await readDatabase();
    const user = database.users.find((item) => item.email === email);

    if (!user || !verifyPassword(password, user)) {
      sendJson(response, 401, { error: "Email or password is incorrect." });
      return;
    }

    const session = createSession(database, user.id);
    user.updatedAt = new Date().toISOString();
    await writeDatabase(database);

    sendJson(response, 200, { user: publicUser(user) }, { "Set-Cookie": createSessionCookie(session.id) });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Could not log in right now." });
  }
}

async function handleLogoutRequest(request, response) {
  try {
    const { database, session } = await getRequestContext(request);

    if (session) {
      database.sessions = database.sessions.filter((item) => item.id !== session.id);
      await writeDatabase(database);
    }

    sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Could not log out right now." });
  }
}

async function handleMeRequest(request, response) {
  try {
    const { user } = await getRequestContext(request);
    sendJson(response, 200, { user: user ? publicUser(user) : null });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Could not load account." });
  }
}

async function handleCheckoutRequest(request, response) {
  try {
    const { database, user } = await getRequestContext(request);

    if (!user) {
      sendJson(response, 401, { error: "Create an account or log in before payment." });
      return;
    }

    const payload = await readJsonPayload(request);
    const plan = String(payload.plan || "monthly").trim() || "monthly";
    const session = await createCheckoutSession({ planId: plan, request, user });

    user.pendingStripeCheckoutSessionId = session.id;
    user.pendingStripePlan = plan;
    user.updatedAt = new Date().toISOString();
    await writeDatabase(database);

    sendJson(response, 200, {
      checkoutReady: true,
      checkoutUrl: session.url,
      sessionId: session.id,
      message: "Opening secure Stripe Checkout.",
      user: publicUser(user),
    });
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, {
      checkoutReady: false,
      error: error.message || "Could not start checkout right now.",
    });
  }
}

async function handleCheckoutConfirmRequest(request, response) {
  try {
    const { database, user } = await getRequestContext(request);

    if (!user) {
      sendJson(response, 401, { error: "Log in before confirming checkout." });
      return;
    }

    const payload = await readJsonPayload(request);
    const sessionId = String(payload.sessionId || "").trim();

    if (!sessionId) {
      sendJson(response, 400, { error: "Stripe session id is required." });
      return;
    }

    const session = await retrieveCheckoutSession(sessionId);

    if ((session.client_reference_id || session.metadata?.userId) !== user.id) {
      sendJson(response, 403, { error: "This checkout session belongs to a different account." });
      return;
    }

    const result = activatePremiumFromSession(database, session);
    await writeDatabase(database);

    sendJson(response, 200, {
      activated: result.activated,
      message: result.activated
        ? "Payment confirmed. Premium is active."
        : result.reason || "Payment is not confirmed yet.",
      user: publicUser(result.user || user),
    });
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, { error: error.message || "Could not confirm checkout." });
  }
}

async function handleStripeWebhookRequest(request, response) {
  try {
    const rawBody = await readRequestBody(request);
    verifyStripeWebhookSignature(rawBody, request.headers["stripe-signature"]);

    const event = JSON.parse(rawBody);

    if (event.type === "checkout.session.completed") {
      const database = await readDatabase();
      const result = activatePremiumFromSession(database, event.data.object);
      await writeDatabase(database);

      if (!result.user) {
        console.warn(result.reason);
      }
    }

    sendJson(response, 200, { received: true });
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 400, { error: error.message || "Webhook failed." });
  }
}

async function handleStudyRequest(request, response) {
  try {
    const payload = await readJsonPayload(request);
    const question = String(payload.question || "").trim();

    if (!question) {
      sendJson(response, 400, { error: "Question is required." });
      return;
    }

    const { database, user } = await getRequestContext(request);

    if (user && !user.isPremium && (Number(user.questionsUsed) || 0) >= FREE_QUESTION_LIMIT) {
      sendJson(response, 402, {
        error: "Your free account has used all 5 questions. Premium should unlock only after Stripe payment is connected.",
        user: publicUser(user),
      });
      return;
    }

    const result = await getOpenAIStudyAnswer(question);

    if (user && !user.isPremium) {
      user.questionsUsed = (Number(user.questionsUsed) || 0) + 1;
      user.updatedAt = new Date().toISOString();
      await writeDatabase(database);
    }

    sendJson(response, 200, {
      ...result,
      user: user ? publicUser(user) : null,
    });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, {
      answer: fallbackStudyAnswer("your question"),
      error: "StudyAI backend fallback was used because the AI request failed.",
      source: "fallback",
    });
  }
}

function handleStatusRequest(response) {
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);

  sendJson(response, 200, {
    backend: true,
    mode: openaiConfigured ? "openai" : "fallback",
    model: process.env.OPENAI_MODEL || "gpt-5.2",
    openaiConfigured,
    stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
  });
}

async function serveStaticFile(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(ROOT_DIR, safePath);
  const pathParts = requestedPath.split("/").filter(Boolean);

  if (
    !filePath.startsWith(ROOT_DIR) ||
    pathParts.some((part) => part.startsWith(".")) ||
    requestedPath === "/data" ||
    requestedPath.startsWith("/data/")
  ) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = createServer(async (request, response) => {
  if (request.url?.startsWith("/api/auth/signup") && request.method === "POST") {
    await handleSignupRequest(request, response);
    return;
  }

  if (request.url?.startsWith("/api/auth/login") && request.method === "POST") {
    await handleLoginRequest(request, response);
    return;
  }

  if (request.url?.startsWith("/api/auth/logout") && request.method === "POST") {
    await handleLogoutRequest(request, response);
    return;
  }

  if (request.url?.startsWith("/api/auth/me") && request.method === "GET") {
    await handleMeRequest(request, response);
    return;
  }

  if (request.url?.startsWith("/api/checkout/confirm") && request.method === "POST") {
    await handleCheckoutConfirmRequest(request, response);
    return;
  }

  if (request.url?.startsWith("/api/checkout") && request.method === "POST") {
    await handleCheckoutRequest(request, response);
    return;
  }

  if (request.url?.startsWith("/api/stripe/webhook") && request.method === "POST") {
    await handleStripeWebhookRequest(request, response);
    return;
  }

  if (request.url?.startsWith("/api/study") && request.method === "POST") {
    await handleStudyRequest(request, response);
    return;
  }

  if (request.url?.startsWith("/api/status") && request.method === "GET") {
    handleStatusRequest(response);
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    await serveStaticFile(request, response);
    return;
  }

  response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`StudyAI server running at http://localhost:${PORT}`);
  console.log(process.env.OPENAI_API_KEY ? "OpenAI API mode: enabled" : "OpenAI API mode: fallback demo");
});
