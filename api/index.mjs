import { createHmac, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const STRIPE_API_URL = "https://api.stripe.com/v1";
const FREE_QUESTION_LIMIT = 5;
const SESSION_COOKIE = "studyai_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const PASSWORD_ITERATIONS = 120_000;
const DB_PATH = join(tmpdir(), "studyai-vercel-db.json");
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

function sendJson(response, status, data, headers = {}) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");

  Object.entries(headers).forEach(([key, value]) => {
    response.setHeader(key, value);
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

async function readJsonPayload(request) {
  const body = await readRequestBody(request);
  return JSON.parse(body || "{}");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createEmptyDatabase() {
  return {
    sessions: [],
    users: [],
  };
}

function normalizeDatabase(data) {
  return {
    sessions: Array.isArray(data?.sessions) ? data.sessions : [],
    users: Array.isArray(data?.users) ? data.users : [],
  };
}

async function readDatabase() {
  try {
    const content = await readFile(DB_PATH, "utf8");
    return normalizeDatabase(JSON.parse(content));
  } catch (error) {
    if (error.code === "ENOENT") return createEmptyDatabase();
    throw error;
  }
}

async function writeDatabase(database) {
  await writeFile(DB_PATH, `${JSON.stringify(normalizeDatabase(database), null, 2)}\n`);
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

function isHttpsRequest(request) {
  return request.headers["x-forwarded-proto"] === "https";
}

function createSessionCookie(request, sessionId) {
  const secure = isHttpsRequest(request) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
}

function clearSessionCookie(request) {
  const secure = isHttpsRequest(request) ? "; Secure" : "";
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function getPlanById(planId) {
  const normalizedPlan = String(planId || "").trim().toLowerCase();
  return Object.entries(PREMIUM_PLANS).find(([, plan]) => plan.aliases.includes(normalizedPlan)) || null;
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

function publicUser(user) {
  updateExpiredPremium(user);
  const questionsUsed = Number(user.questionsUsed) || 0;
  const isPremium = isPremiumActive(user);
  const questionsLeft = isPremium ? null : Math.max(FREE_QUESTION_LIMIT - questionsUsed, 0);

  return {
    email: user.email,
    id: user.id,
    isPremium,
    plan: isPremium ? user.premiumPlan || "premium" : "free",
    premiumUntil: isPremium ? user.premiumUntil || null : null,
    questionsLeft,
    questionsUsed,
  };
}

function createSession(database, userId) {
  const now = new Date();
  const session = {
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString(),
    id: randomUUID(),
    userId,
  };

  database.sessions.push(session);
  return session;
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

function formatNumber(number) {
  if (Number.isInteger(number)) return String(number);
  return Number(number.toFixed(3)).toString();
}

function fallbackStudyAnswer(question) {
  const percentage = question.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of|de)\s*(\d+(?:\.\d+)?)/i);
  if (percentage) {
    const percent = Number(percentage[1]);
    const amount = Number(percentage[2]);
    const answer = (percent / 100) * amount;

    return `Topic: percentages

Key idea: percent means "out of 100."

Explanation:
To find ${formatNumber(percent)}% of ${formatNumber(amount)}, divide the percent by 100 and multiply by the number.

Example:
${formatNumber(percent)} / 100 = ${formatNumber(percent / 100)}
${formatNumber(percent / 100)} x ${formatNumber(amount)} = ${formatNumber(answer)}

Practice:
Find 15% of 60.

Next step:
Ask another percentage question and StudyAI will show the steps.`;
  }

  return `Topic: ${question}

Key idea: Most confusing topics become easier when they are broken into smaller parts.

Explanation: First define the important words, then connect the ideas in order.

Example: For a science process, write it as start -> change -> result.

Practice: Write one sentence explaining the topic in your own words.

Next step: Ask a more specific homework question for a better lesson.`;
}

function buildTutorPrompt(question) {
  return `You are StudyAI, a study-focused tutor for students.

Your job:
- Explain like a patient teacher.
- Do not just give the final answer.
- Use clear student-friendly language.
- Keep the answer useful but not too long.
- If it is math, show steps and a check.
- End with one practice task.

Always use this structure:
Topic:
Key idea:
Explanation:
Example:
Practice:
Next step:

Student question: ${question}`;
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
    body: JSON.stringify({
      input: buildTutorPrompt(question),
      model,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!openaiResponse.ok) {
    const details = await openaiResponse.text();
    throw new Error(`OpenAI request failed: ${openaiResponse.status} ${details}`);
  }

  const data = await openaiResponse.json();
  return {
    answer: data.output_text || fallbackStudyAnswer(question),
    source: "openai",
  };
}

function getAppUrl(request) {
  const configuredUrl = process.env.APP_URL || process.env.SITE_URL;
  if (configuredUrl) return configuredUrl.replace(/\/$/, "");

  const protocol = request.headers["x-forwarded-proto"] || "https";
  return `${protocol}://${request.headers.host}`;
}

function assertStripeConfigured() {
  if (!process.env.STRIPE_SECRET_KEY) {
    const error = new Error("Stripe is not connected yet. Add STRIPE_SECRET_KEY in Vercel first.");
    error.statusCode = 503;
    throw error;
  }
}

async function stripeRequest(path, { method = "GET", params } = {}) {
  assertStripeConfigured();

  const options = {
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
    },
    method,
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

  return stripeRequest("/checkout/sessions", {
    method: "POST",
    params: {
      "cancel_url": `${appUrl}/?checkout=cancel#plans`,
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
      "success_url": `${appUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}#chat`,
    },
  });
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

  if (Math.abs(Date.now() / 1000 - timestamp) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
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
    if (database.users.find((user) => user.email === email)) {
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

    sendJson(response, 201, { user: publicUser(user) }, { "Set-Cookie": createSessionCookie(request, session.id) });
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

    sendJson(response, 200, { user: publicUser(user) }, { "Set-Cookie": createSessionCookie(request, session.id) });
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

    sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie(request) });
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
      message: "Opening secure Stripe Checkout.",
      sessionId: session.id,
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
      message: result.activated ? "Payment confirmed. Premium is active." : result.reason || "Payment is not confirmed yet.",
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
      activatePremiumFromSession(database, event.data.object);
      await writeDatabase(database);
    }

    sendJson(response, 200, { received: true });
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 400, { error: error.message || "Webhook failed." });
  }
}

function handleStatusRequest(response) {
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);

  sendJson(response, 200, {
    backend: true,
    databaseMode: "temporary-vercel-filesystem",
    mode: openaiConfigured ? "openai" : "fallback",
    model: process.env.OPENAI_MODEL || "gpt-5.2",
    openaiConfigured,
    stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
  });
}

function getApiPath(request) {
  const url = new URL(request.url, `https://${request.headers.host || "localhost"}`);
  const rewrittenPath = url.searchParams.get("path");
  if (rewrittenPath) return rewrittenPath.replace(/^\/+/, "");
  return url.pathname.replace(/^\/api\/?/, "").replace(/^\/+/, "");
}

export default async function handler(request, response) {
  const apiPath = getApiPath(request);

  if (request.method === "GET" && apiPath === "status") {
    handleStatusRequest(response);
    return;
  }

  if (request.method === "POST" && apiPath === "study") {
    await handleStudyRequest(request, response);
    return;
  }

  if (request.method === "POST" && apiPath === "auth/signup") {
    await handleSignupRequest(request, response);
    return;
  }

  if (request.method === "POST" && apiPath === "auth/login") {
    await handleLoginRequest(request, response);
    return;
  }

  if (request.method === "POST" && apiPath === "auth/logout") {
    await handleLogoutRequest(request, response);
    return;
  }

  if (request.method === "GET" && apiPath === "auth/me") {
    await handleMeRequest(request, response);
    return;
  }

  if (request.method === "POST" && apiPath === "checkout") {
    await handleCheckoutRequest(request, response);
    return;
  }

  if (request.method === "POST" && apiPath === "checkout/confirm") {
    await handleCheckoutConfirmRequest(request, response);
    return;
  }

  if (request.method === "POST" && apiPath === "stripe/webhook") {
    await handleStripeWebhookRequest(request, response);
    return;
  }

  sendJson(response, 404, { error: "API route not found." });
}
