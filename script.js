const FREE_QUESTION_LIMIT = 5;
const PAYMENTS_CONNECTED = false;
const LAST_ACCOUNT_EMAIL_KEY = "studyaiLastAccountEmail";

if (!PAYMENTS_CONNECTED) {
  localStorage.removeItem("studyaiPremium");
}

const state = {
  account: null,
  questionsUsed: Number(localStorage.getItem("studyaiQuestionsUsed")) || 0,
  isPremium: PAYMENTS_CONNECTED && localStorage.getItem("studyaiPremium") === "true",
};

const form = document.querySelector("#questionForm");
const input = document.querySelector("#questionInput");
const messages = document.querySelector("#chatMessages");
const usageText = document.querySelector("#usageText");
const planBadge = document.querySelector("#planBadge");
const askButton = document.querySelector("#askButton");
const limitWarning = document.querySelector("#limitWarning");
const aiModeText = document.querySelector("#aiModeText");
const premiumButtons = document.querySelectorAll(".premium-button");
const resetButton = document.querySelector("#resetButton");
const accountButton = document.querySelector("#accountButton");
const logoutButton = document.querySelector("#logoutButton");
const promptButtons = document.querySelectorAll(".prompt-chip");
const authModal = document.querySelector("#authModal");
const authTitle = document.querySelector("#authTitle");
const authPlan = document.querySelector(".auth-plan");
const authPlanName = document.querySelector("#authPlanName");
const authForm = document.querySelector("#authForm");
const authEmail = document.querySelector("#authEmail");
const authPassword = document.querySelector("#authPassword");
const authSubmitButton = document.querySelector("#authSubmitButton");
const authMessage = document.querySelector("#authMessage");
const authTabs = document.querySelectorAll(".auth-tab");
const closeAuthButtons = document.querySelectorAll("[data-close-auth]");

let selectedPlan = "";
let authMode = "signup";
let authPurpose = "checkout";

function saveState() {
  localStorage.setItem("studyaiQuestionsUsed", String(state.questionsUsed));

  if (PAYMENTS_CONNECTED) {
    localStorage.setItem("studyaiPremium", String(state.isPremium));
  } else {
    localStorage.removeItem("studyaiPremium");
  }
}

function questionsLeft() {
  if (state.account && Number.isFinite(Number(state.account.questionsLeft))) {
    return Math.max(Number(state.account.questionsLeft), 0);
  }

  return Math.max(FREE_QUESTION_LIMIT - state.questionsUsed, 0);
}

function updateInterface() {
  document.body.classList.toggle("premium-active", state.isPremium);
  accountButton.hidden = Boolean(state.account);
  logoutButton.hidden = !state.account;

  if (state.isPremium) {
    planBadge.textContent = "Premium plan";
    usageText.textContent = state.account ? `${state.account.email} · unlimited questions` : "Unlimited questions this month";
    premiumButtons.forEach((button) => {
      button.textContent = "Premium active";
      button.disabled = true;
    });
    askButton.disabled = false;
    limitWarning.hidden = true;
    return;
  }

  const left = questionsLeft();
  planBadge.textContent = state.account ? "Free account" : "Free plan";
  usageText.textContent = `${left} ${left === 1 ? "question left" : "questions left"}`;
  premiumButtons.forEach((button) => {
    button.textContent = button.dataset.cta || `Choose ${button.dataset.plan}`;
    button.disabled = false;
  });
  askButton.disabled = left === 0;
  limitWarning.hidden = left !== 0;
}

function addMessage(type, text, options = {}) {
  const message = document.createElement("article");
  message.className = `message ${type}`;
  if (options.pending) {
    message.classList.add("pending");
  }

  const author = document.createElement("strong");
  author.textContent = type === "user" ? "You" : "StudyAI";

  const paragraph = document.createElement("p");
  paragraph.textContent = text;

  message.append(author, paragraph);
  messages.append(message);
  messages.scrollTop = messages.scrollHeight;

  return { message, paragraph };
}

function setAiMode(text, mode) {
  aiModeText.textContent = text;
  aiModeText.classList.toggle("api-ready", mode === "openai");
  aiModeText.classList.toggle("fallback-mode", mode !== "openai");
}

function setAccount(account) {
  state.account = account;
  state.isPremium = Boolean(account?.isPremium);

  if (account) {
    state.questionsUsed = Number(account.questionsUsed) || 0;
    localStorage.setItem(LAST_ACCOUNT_EMAIL_KEY, account.email);
  }

  updateInterface();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || "Request failed.");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function loadCurrentAccount() {
  try {
    const data = await fetch("/api/auth/me", { cache: "no-store" }).then((response) => response.json());
    setAccount(data.user || null);
    return data.user || null;
  } catch {
    setAccount(null);
    return null;
  }
}

async function updateApiStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("Status unavailable.");

    const status = await response.json();
    setAiMode(status.openaiConfigured ? "Real AI API" : "Backend fallback", status.mode);
  } catch {
    setAiMode("Browser fallback", "fallback");
  }
}

async function getStudyAnswer(question) {
  try {
    const response = await fetch("/api/study", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question }),
    });
    const data = await response.json().catch(() => ({}));

    if (response.status === 402) {
      if (data.user) setAccount(data.user);
      return {
        answered: false,
        text: data.error || "Your free questions are finished. Choose a premium plan to continue.",
      };
    }

    if (!response.ok) {
      throw new Error(data.error || "Study backend request failed.");
    }

    if (data.user) setAccount(data.user);
    setAiMode(data.source === "openai" ? "Real AI API" : "Backend fallback", data.source);
    return {
      answered: true,
      text: data.answer || createStudyAnswer(question),
    };
  } catch {
    setAiMode("Browser fallback", "fallback");
    return {
      answered: true,
      text: createStudyAnswer(question),
    };
  }
}

function getLastAccountEmail() {
  return state.account?.email || localStorage.getItem(LAST_ACCOUNT_EMAIL_KEY) || "";
}

function setAuthMode(mode) {
  authMode = mode;
  const isSignup = authMode === "signup";

  if (authPurpose === "checkout") {
    authTitle.textContent = isSignup ? "Create an account before checkout." : "Log in before checkout.";
  } else {
    authTitle.textContent = isSignup ? "Create your StudyAI account." : "Log in to your StudyAI account.";
  }

  authSubmitButton.textContent = isSignup ? "Create account and continue" : "Log in and continue";
  authPassword.setAttribute("autocomplete", isSignup ? "new-password" : "current-password");
  authMessage.hidden = true;

  authTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.authMode === authMode);
  });
}

function openAuthModal(planName, purpose = "checkout") {
  selectedPlan = planName;
  authPurpose = purpose;

  if (state.account && authPurpose === "checkout") {
    continueToCheckout();
    return;
  }

  authPlan.hidden = authPurpose !== "checkout";
  authPlanName.textContent = planName || "Premium";
  authEmail.value = getLastAccountEmail();
  authPassword.value = "";
  setAuthMode(getLastAccountEmail() ? "login" : "signup");
  authModal.hidden = false;
  document.body.classList.add("modal-open");
  authEmail.focus();
}

function closeAuthModal() {
  authModal.hidden = true;
  document.body.classList.remove("modal-open");
}

async function continueToCheckout() {
  try {
    if (!selectedPlan) {
      throw new Error("Choose a premium plan before checkout.");
    }

    const data = await requestJson("/api/checkout", {
      method: "POST",
      body: JSON.stringify({ plan: selectedPlan }),
    });

    if (data.user) setAccount(data.user);

    if (data.checkoutUrl) {
      authSubmitButton.textContent = "Opening Stripe...";
      window.location.href = data.checkoutUrl;
      return;
    }

    closeAuthModal();
    document.querySelector("#chat").scrollIntoView({ behavior: "smooth" });
    addMessage("assistant", data.message || "Stripe Checkout is not ready yet.");
  } catch (error) {
    const message = error.message || "Create an account or log in before checkout.";

    if (authModal.hidden) {
      document.querySelector("#chat").scrollIntoView({ behavior: "smooth" });
      addMessage("assistant", message);
      return;
    }

    authMessage.textContent = message;
    authMessage.hidden = false;
  }
}

async function handleCheckoutReturn() {
  const url = new URL(window.location.href);
  const checkoutStatus = url.searchParams.get("checkout");
  const sessionId = url.searchParams.get("session_id");

  if (!checkoutStatus) return;

  document.querySelector("#chat").scrollIntoView({ behavior: "smooth" });

  if (checkoutStatus === "cancel") {
    addMessage("assistant", "Checkout was cancelled. Your card was not charged.");
  }

  if (checkoutStatus === "success" && sessionId) {
    addMessage("assistant", "Payment received by Stripe. Confirming premium with the backend...");

    try {
      const data = await requestJson("/api/checkout/confirm", {
        method: "POST",
        body: JSON.stringify({ sessionId }),
      });

      if (data.user) setAccount(data.user);
      addMessage("assistant", data.message || "Checkout confirmed.");
    } catch (error) {
      addMessage("assistant", error.message || "Payment could not be confirmed yet. Try refreshing in a moment.");
    }
  }

  url.searchParams.delete("checkout");
  url.searchParams.delete("session_id");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash || "#chat"}`);
}

function formatNumber(number) {
  if (Number.isInteger(number)) return String(number);
  return Number(number.toFixed(3)).toString();
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

function explainLinearEquation(parsedEquation) {
  const { coefficient, constant, equation, result, solution } = parsedEquation;
  const constantSign = constant >= 0 ? `+ ${formatNumber(constant)}` : `- ${formatNumber(Math.abs(constant))}`;
  const oppositeOperation = constant >= 0 ? `subtract ${formatNumber(constant)}` : `add ${formatNumber(Math.abs(constant))}`;
  const afterConstant = result - constant;

  return `Topic: solving a linear equation

Key idea: x is an unknown number. ${formatNumber(coefficient)}x means ${formatNumber(coefficient)} times x. That is different from x + ${formatNumber(Math.abs(constant))}, which means x plus a number.

Equation:
${equation.replace("=", " = ")}

Step 1: remove the number next to the x term.
${formatNumber(coefficient)}x ${constantSign} = ${formatNumber(result)}
We ${oppositeOperation} on both sides.

Step 2: simplify.
${formatNumber(coefficient)}x = ${formatNumber(afterConstant)}

Step 3: divide by ${formatNumber(coefficient)} because ${formatNumber(coefficient)}x means ${formatNumber(coefficient)} times x.
x = ${formatNumber(afterConstant)} / ${formatNumber(coefficient)}
x = ${formatNumber(solution)}

Check:
${formatNumber(coefficient)} × ${formatNumber(solution)} ${constantSign} = ${formatNumber(result)}

Practice: try another one like 4x + 2 = 18.`;
}

function explainAlgebraTestPrep() {
  return `Topic: algebra test preparation

Let's learn it like a teacher would explain it before a test.

Key idea:
Algebra uses letters, like x, for numbers we do not know yet. Your job is to discover what the letter must be.

Lesson 1: what the parts mean
x = the unknown number
3x = 3 times the unknown number
+4 = add 4
= 10 = the total must be 10

So this equation:
3x + 4 = 10

means:
"Three times a number, plus four, equals ten."

Lesson 2: how to solve it
We want x alone.

Step 1: remove +4 by subtracting 4 from both sides.
3x = 6

Step 2: 3x means 3 times x, so divide by 3.
x = 2

Check:
3 × 2 + 4 = 10
6 + 4 = 10
Correct.

Your test study plan:
1. Learn vocabulary: variable, coefficient, constant, equation.
2. Practice simple equations: x + 5 = 12.
3. Practice multiplication equations: 3x = 15.
4. Practice two-step equations: 3x + 4 = 10.
5. Always check your answer in the original equation.

Try these now:
1. x + 7 = 15
2. 2x = 14
3. 4x + 3 = 19

Answers:
1. x = 8
2. x = 7
3. x = 4

Next step:
Send me one algebra exercise from your revision sheet, and I will solve it with you step by step.`;
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function createLesson({ topic, keyIdea, explanation, example, practice, nextStep }) {
  return `Topic: ${topic}

Key idea: ${keyIdea}

Explanation: ${explanation}

Example: ${example}

Practice: ${practice}

Next step: ${nextStep}`;
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

function explainPercentages(question) {
  const parsedPercentage = parsePercentage(question);

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

Practice: find 15% of 60. Hint: 15% = 0.15, then multiply by 60.

Next step: send me another percentage question and I will show the steps.`;
  }

  return createLesson({
    topic: "percentages",
    keyIdea: "A percentage is a fraction with 100 as the hidden bottom number.",
    explanation: "When you see 25%, think 25 out of 100. To calculate it, divide by 100 and multiply by the number.",
    example: "25% of 80 means 0.25 x 80 = 20.",
    practice: "Find 10% of 90, then find 20% of 90.",
    nextStep: "Ask a specific question like 'What is 15% of 200?' and I will solve it step by step.",
  });
}

function explainPhotosynthesis() {
  return createLesson({
    topic: "photosynthesis",
    keyIdea: "Plants use light energy to make their own food.",
    explanation: "A plant takes in carbon dioxide from the air and water from the soil. With sunlight, it changes them into glucose, which is sugar the plant can use for energy. Oxygen is released as a leftover product.",
    example: "The short version is: carbon dioxide + water + light -> glucose + oxygen.",
    practice: "Write one sentence explaining what the plant takes in, and one sentence explaining what it produces.",
    nextStep: "If this is for a test, ask me for a 5-question quiz on photosynthesis.",
  });
}

function explainEssayWriting() {
  return createLesson({
    topic: "essay writing",
    keyIdea: "A strong essay is built around one clear main argument.",
    explanation: "Start with your thesis, then make each paragraph prove one part of that thesis. A simple paragraph structure is point, evidence, explanation, and link back to the question.",
    example: "If the essay asks whether homework is useful, your thesis could be: Homework is useful when it helps students practice skills they already learned in class.",
    practice: "Write one thesis sentence, then list three paragraph points that would support it.",
    nextStep: "Send me your essay question and I will help you build a plan.",
  });
}

function explainStudyPlan() {
  return createLesson({
    topic: "exam study plan",
    keyIdea: "Good studying is active: explain, practice, check, then fix weak spots.",
    explanation: "Do not only reread notes. Split the topic into small parts. For each part, write what you remember, solve practice questions, check your mistakes, and repeat the hardest parts.",
    example: "For a math test, spend 10 minutes reviewing rules, 25 minutes solving exercises, and 10 minutes correcting mistakes.",
    practice: "Choose one subject and make three lists: what I know, what I partly know, and what I need to practice.",
    nextStep: "Tell me your subject and test date, and I will create a simple revision plan.",
  });
}

function explainScienceTopic(question) {
  return createLesson({
    topic: question,
    keyIdea: "Science becomes easier when you connect vocabulary to a process.",
    explanation: "First define the important words. Then ask what starts the process, what changes, and what the result is. This turns a confusing paragraph into a clear chain of events.",
    example: "For digestion, you can track the process: food enters the mouth, gets broken down, nutrients are absorbed, and waste leaves the body.",
    practice: "Pick one science process and write it as 4 arrows: start -> change -> result -> why it matters.",
    nextStep: "Send me the exact science topic, like 'cells', 'forces', or 'electric circuits', and I will make a focused lesson.",
  });
}

function createStudyAnswer(question) {
  const lowerQuestion = question.toLowerCase();
  const parsedEquation = parseLinearEquation(question);
  const isTestPrepQuestion = lowerQuestion.includes("test") || lowerQuestion.includes("exam") || lowerQuestion.includes("learn") || lowerQuestion.includes("study");

  if (lowerQuestion.includes("algebra") && isTestPrepQuestion) {
    return explainAlgebraTestPrep();
  }

  if (parsedEquation) {
    return explainLinearEquation(parsedEquation);
  }

  if (includesAny(lowerQuestion, ["percent", "percentage", "%", "prozent", "pourcentage"])) {
    return explainPercentages(question);
  }

  if (includesAny(lowerQuestion, ["photosynthesis", "plant food", "chlorophyll"])) {
    return explainPhotosynthesis();
  }

  if (lowerQuestion.includes("fraction") || lowerQuestion.includes("fraccion") || lowerQuestion.includes("fracción")) {
    return `Topic: fractions

Key idea: a fraction shows a part of a whole.

Explanation: imagine a pizza cut into 4 equal slices. Each slice is 1/4 of the pizza. The bottom number tells you how many equal parts the whole is divided into. The top number tells you how many parts you have.

Example: 3/5 means the whole is divided into 5 equal parts, and you have 3 of those parts.

Practice: if a chocolate bar has 8 pieces and you eat 2, what fraction did you eat? Answer: 2/8, which can be simplified to 1/4.`;
  }

  if (lowerQuestion.includes("history") || lowerQuestion.includes("revolution")) {
    return `Topic: history

Key idea: history is not only about memorizing dates. It is about understanding causes, events, and consequences.

Explanation: most historical events have 3 parts. First, the causes: the problems or tensions that created the event. Then, the events: what actually happened. Finally, the consequences: what changed afterwards.

Example: when studying a revolution, ask: what problem existed, who protested, what happened, and what changed after it?

Practice: choose one history topic and write one sentence for each part: cause, event, and consequence.`;
  }

  if (includesAny(lowerQuestion, ["essay", "paragraph", "argument", "thesis"])) {
    return explainEssayWriting();
  }

  if (lowerQuestion.includes("summary") || lowerQuestion.includes("summarize") || lowerQuestion.includes("resumen")) {
    return `Topic: writing a summary

Key idea: summarizing is not copying less text. It means keeping only the most important ideas.

Explanation: first, read the full text. Then, find the main ideas, not every small detail. Finally, rewrite the meaning in your own words, as if you were explaining it to someone who did not read the text.

Example: if a text is about water pollution, your summary should explain what it is, why it happens, and what problems it causes.

Practice: summarize one paragraph in only 3 sentences: main topic, important detail, and conclusion.`;
  }

  if (lowerQuestion.includes("english") || lowerQuestion.includes("grammar")) {
    return `Topic: building a sentence in English

Key idea: English becomes easier when you understand sentence structure instead of memorizing random words.

Explanation: a basic sentence often follows this pattern: person + verb + extra information. For example, "I study math." "I" is the person, "study" is the verb, and "math" is the thing being studied.

Example: "She reads a book" means one person is doing an action. Change "reads" to "writes" and you get "She writes a book."

Practice: create 3 sentences using this pattern: I + verb + extra information.`;
  }

  if (includesAny(lowerQuestion, ["science", "biology", "chemistry", "physics", "cells", "force", "energy", "electric"])) {
    return explainScienceTopic(question);
  }

  if (lowerQuestion.includes("equation") || lowerQuestion.includes("algebra") || lowerQuestion.includes("ecuacion") || lowerQuestion.includes("ecuación")) {
    return `Topic: equations

Key idea: an equation is like a balance scale. Whatever you do to one side, you must also do to the other side.

Explanation: there are different kinds of simple equations. x + 3 = 10 means "a number plus 3 equals 10." But 3x + 4 = 10 means "three times a number plus 4 equals 10." The little number in front of x is important because it means multiplication.

Example:
3x + 4 = 10
3x = 10 - 4
3x = 6
x = 6 / 3
x = 2

Practice: type an equation like 4x + 2 = 18 and I will solve it step by step.`;
  }

  if (lowerQuestion.includes("exam") || lowerQuestion.includes("test") || lowerQuestion.includes("revision")) {
    return explainStudyPlan();
  }

  return createLesson({
    topic: question,
    keyIdea: "Most confusing topics become easier when we break them into small parts.",
    explanation: "First, find the important words. Next, ask what each word means. Then connect the ideas in order. This turns the topic from something to memorize into something you can explain.",
    example: "If the topic is 'volcanoes', we would learn what magma is, why pressure builds up, what an eruption is, and what happens after.",
    practice: "Write the topic as one question beginning with 'How' or 'Why'. That makes it easier to study.",
    nextStep: "Send the exact subject and topic, like 'biology: cells' or 'math: percentages', and I will make the answer more specific.",
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const question = input.value.trim();
  if (!question) return;

  if (!state.isPremium && questionsLeft() === 0) {
    updateInterface();
    return;
  }

  addMessage("user", question);
  input.value = "";
  askButton.disabled = true;
  askButton.textContent = "Thinking...";
  const pendingMessage = addMessage("assistant", "StudyAI is thinking...", { pending: true });
  const result = await getStudyAnswer(question);
  pendingMessage.paragraph.textContent = result.text;
  pendingMessage.message.classList.remove("pending");

  if (result.answered && !state.account && !state.isPremium) {
    state.questionsUsed += 1;
  }

  askButton.textContent = "Ask";
  saveState();
  updateInterface();
});

promptButtons.forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.prompt;
    input.focus();
  });
});

premiumButtons.forEach((button) => {
  button.addEventListener("click", () => {
    openAuthModal(button.dataset.plan);
  });
});

authTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setAuthMode(tab.dataset.authMode);
  });
});

closeAuthButtons.forEach((button) => {
  button.addEventListener("click", closeAuthModal);
});

authForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const email = authEmail.value.trim();
  if (!email || authPassword.value.length < 6) {
    authMessage.textContent = "Use an email and a password with at least 6 characters.";
    authMessage.hidden = false;
    return;
  }

  authSubmitButton.disabled = true;
  authSubmitButton.textContent = authMode === "signup" ? "Creating..." : "Logging in...";

  requestJson(`/api/auth/${authMode === "signup" ? "signup" : "login"}`, {
    method: "POST",
    body: JSON.stringify({
      email,
      password: authPassword.value,
    }),
  })
    .then((data) => {
      setAccount(data.user);
      if (authPurpose === "checkout") {
        return continueToCheckout();
      }

      closeAuthModal();
      addMessage("assistant", `Logged in as ${data.user.email}.`);
      return null;
    })
    .catch((error) => {
      authMessage.textContent = error.message || "Account request failed.";
      authMessage.hidden = false;
    })
    .finally(() => {
      authSubmitButton.disabled = false;
      authSubmitButton.textContent = authMode === "signup" ? "Create account and continue" : "Log in and continue";
    });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !authModal.hidden) {
    closeAuthModal();
  }
});

resetButton.addEventListener("click", () => {
  state.questionsUsed = 0;
  if (!state.account) {
    state.isPremium = false;
    localStorage.removeItem(LAST_ACCOUNT_EMAIL_KEY);
  }
  saveState();
  updateInterface();
  messages.innerHTML = "";
  addMessage(
    "assistant",
    state.account
      ? "Chat reset. Your account and saved question usage stay on the backend."
      : "Demo reset. Write a topic and I will explain it like a mini lesson."
  );
});

accountButton.addEventListener("click", () => {
  openAuthModal("StudyAI account", "account");
});

logoutButton.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  setAccount(null);
  updateInterface();
  addMessage("assistant", "You are logged out. The free demo limit on this browser is still separate from saved account usage.");
});

updateInterface();
updateApiStatus();
loadCurrentAccount().then(handleCheckoutReturn);
