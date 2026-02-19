require("dotenv").config();
const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const connectDB = require("./config/dbConnection");
const OTP = require("./model/OTP");
const Session = require("./model/Session");

puppeteer.use(StealthPlugin());

const app = express();


app.use(express.json());

const cors = require("cors");
app.use(cors());

const PORT = process.env.PORT || 8080;


// Connect to MongoDB
connectDB();

// ============== In‑memory active browser sessions ==============
let activeBrowserSessions = {};

// Utility: wait
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Get Chrome profile path
function getChromeProfile() {
  const username = process.env.USERNAME || "prash";
  return `C:/Users/${username}/AppData/Local/Google/Chrome/User Data`;
}

// ============== Active session management ==============
async function storeActiveBrowserSession(phoneNumber, browser, page) {
  try {
    const sessionId = Date.now().toString();
    activeBrowserSessions[phoneNumber] = {
      browser,
      page,
      sessionId,
      timestamp: Date.now(),
    };

    console.log(`✅ Active browser session stored for ${phoneNumber}`);
    return sessionId;
  } catch (error) {
    console.error("Error storing active session:", error);
    return null;
  }
}

function getActiveBrowserPage(phoneNumber) {
  const session = activeBrowserSessions[phoneNumber];
  if (session && session.page && !session.page.isClosed()) {
    console.log(`✅ Found active browser session for ${phoneNumber}`);
    return session.page;
  }
  console.log(`❌ No active browser session found for ${phoneNumber}`);
  return null;
}


// ============== OTP Storage ==============
async function storeOTP(phoneNumber, otp) {
  try {
    // Expire old pending OTPs
    await OTP.updateMany(
      { phoneNumber, status: "pending" },
      { status: "expired" },
    );

    const otpEntry = await OTP.create({
      phoneNumber,
      otp,
      status: "pending",
    });

    console.log(`✅ OTP ${otp} stored for ${phoneNumber}`);
    return otpEntry;
  } catch (error) {
    console.error("Error storing OTP:", error);
  }
}

// ============== Browser State Storage ==============
async function captureBrowserStorage(page) {
  try {
    return await page.evaluate(() => ({
      localStorage: { ...localStorage },
      sessionStorage: { ...sessionStorage },
      loginCheck: localStorage.getItem("LOGIN_CHECK") || null,
    }));
  } catch (error) {
    console.error("Error capturing storage:", error);
    return null;
  }
}

function formatCookiesForHeaders(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function storeBrowserState(phoneNumber, page, cookies) {
  try {
    const currentUrl = await page.url();
    const pageTitle = await page.title();
    const cookiesString = formatCookiesForHeaders(cookies);
    const storageData = await captureBrowserStorage(page);

    const merchantTokens = cookies.filter(
      (cookie) =>
        cookie.name.toLowerCase().includes("token") ||
        cookie.name.toLowerCase().includes("merchant") ||
        cookie.name.toLowerCase().includes("session") ||
        cookie.name.toLowerCase().includes("olympus"),
    );

    const stateData = {
      phoneNumber,
      cookies,
      cookiesString,
      cookieCount: cookies.length,
      merchantTokens: merchantTokens.map((t) => ({
        name: t.name,
        value: t.value,
      })),
      storage: storageData,
      loginCheck: storageData?.loginCheck,
      domain: "business.phonepe.com",
      url: currentUrl,
      pageTitle,
      isLoggedIn: true,
      authType: storageData?.loginCheck
        ? JSON.parse(storageData.loginCheck).authType
        : null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      headers: {
        Cookie: cookiesString,
        "User-Agent": await page.evaluate(() => navigator.userAgent),
        Authorization:
          merchantTokens.length > 0
            ? `Bearer ${merchantTokens[0].value}`
            : undefined,
      },
      lastUsed: new Date(),
    };

    await Session.findOneAndUpdate({ phoneNumber }, stateData, {
      upsert: true,
    });
    console.log(`✅ Session stored in MongoDB for ${phoneNumber}`);
    return {
      success: true,
      merchantTokens: merchantTokens.length,
      loginCheck: storageData?.loginCheck,
    };
  } catch (error) {
    console.error("Error storing browser state:", error);
    return { success: false, error: error.message };
  }
}

// ============== Load Stored State from MongoDB ==============
async function loadStoredState(phoneNumber) {
  try {
    const session = await Session.findOne({ phoneNumber }).lean();
    if (!session) return null;

    const sessionAge = Date.now() - new Date(session.lastUsed).getTime();
    const hoursOld = sessionAge / (1000 * 60 * 60);
    if (hoursOld <= 168 && session.merchantTokens?.length) {
      console.log(
        `✅ Valid MongoDB session found for ${phoneNumber} (${Math.round(hoursOld * 10) / 10} hours old)`,
      );
      return session;
    }
    console.log(`⚠️ Session expired or no merchant tokens for ${phoneNumber}`);
    return null;
  } catch (error) {
    console.error("Error loading state:", error);
    return null;
  }
}

// ============== Restore Browser State ==============
async function restoreBrowserState(page, phoneNumber) {
  console.log("🔍 Restoring browser state for existing user...");
  const state = await loadStoredState(phoneNumber);
  if (!state || !state.cookies?.length) return false;

  try {
    const sanitizedCookies = state.cookies.map((cookie) => {
      return {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || "/",
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      };
    });

    await page.setCookie(...sanitizedCookies);

    console.log("✅ Loaded stored cookies");

    await page.goto("https://business.phonepe.com", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await wait(3000);


    await page.evaluate((storageData) => {
      localStorage.clear();
      sessionStorage.clear();

      Object.entries(storageData.localStorage || {}).forEach(([k, v]) =>
        localStorage.setItem(k, v),
      );

      Object.entries(storageData.sessionStorage || {}).forEach(([k, v]) =>
        sessionStorage.setItem(k, v),
      );
    }, state.storage);

    await wait(5000);
    await page.reload({ waitUntil: "networkidle2" });

    await page.goto("https://business.phonepe.com/dashboard", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await wait(3000);

    const currentUrl = await page.url();
    const isOnDashboard =
      currentUrl.includes("/dashboard") || !currentUrl.includes("/login");
    if (isOnDashboard) {
      console.log("🎉 Successfully restored session! User is on dashboard.");
      const freshCookies = await page.cookies();
      await storeBrowserState(phoneNumber, page, freshCookies);
      return true;
    }
    console.log("⚠️ Restore failed - not on dashboard");
    return false;
  } catch (error) {
    console.log("⚠️ Error restoring state:", error.message);
    return false;
  }
}

// ============== Auto‑OTP Polling ==============
async function pollForOTPAndSubmit(phoneNumber, page, browser) {
  return new Promise((resolve, reject) => {
    const pollInterval = 5000; // Check every 5 seconds
    const maxAttempts = 20; // 5 minutes total
    let attempts = 0;

    const intervalId = setInterval(async () => {
      attempts++;
      try {
        const otpDoc = await OTP.findOne({ phoneNumber, status: "pending" })
          .sort({ createdAt: -1 })
          .lean();
        if (otpDoc) {
          clearInterval(intervalId);
          console.log(`🔢 Found OTP ${otpDoc.otp} in MongoDB, filling now...`);

          console.log("✅ OTP find in DB...");

          // Type the OTP character by character with realistic delay
          await page.type("#mobile_otp", otpDoc.otp, { delay: 1000 });


          // Mark OTP as used in DB
          await OTP.updateOne(
            { _id: otpDoc._id },
            { status: "used", usedAt: new Date() },
          );

          // Short pause for any background validation
          await wait(5000);
          // ---- END: ROBUST OTP FILLING ----

          // Find and click CONFIRM button (same as before)
          let confirmButton = await page.$(
            'button[data-id="verify-otp-drawer-confirm-button"]',
          );

          await wait(5000);

          if (!confirmButton) {
            const buttons = await page.$$("button");
            for (const btn of buttons) {
              const text = await btn.evaluate(
                (el) => el.textContent?.trim() || "",
              );
              if (
                text === "CONFIRM" ||
                text.includes("CONFIRM") ||
                text.includes("Verify")
              ) {
                confirmButton = btn;
                break;
              }
            }
          }

          if (!confirmButton) {
            reject(new Error("CONFIRM button not found"));
            return;
          }

          await Promise.all([
            page.waitForNavigation({
              waitUntil: "networkidle2",
              timeout: 15000,
            }),
            confirmButton.click(),
          ]);

          await wait(5000);

          const currentUrl = await page.url();

          // If URL no longer contains '/login', assume success
          if (!currentUrl.includes("/login")) {
            console.log("✅ Login successful, navigating to dashboard...");
            await page.goto("https://business.phonepe.com/dashboard", {
              waitUntil: "networkidle2",
            });
            const cookies = await page.cookies();
            await storeBrowserState(phoneNumber, page, cookies);
            resolve();
          } else {
            reject(
              new Error("Login failed after OTP submit – still on login page"),
            );
          }
        } else if (attempts >= maxAttempts) {
          clearInterval(intervalId);
          reject(new Error("OTP timeout – no OTP received within 5 minutes"));
        }
      } catch (error) {
        clearInterval(intervalId);
        reject(error);
      }
    }, pollInterval);
  });
}


app.post("/api/demo", async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ status: "false", message: "Phone number required" });
  }

  return res.json({ status: "true", phoneNumber: phone });
});


// Start login or restore session
app.post("/api/phonepe-automate", async (req, res) => {
  console.log("\n=== Starting PhonePe Business Automation ===");
  let browser = null;
  let page = null;
  let responseSent = false;

  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res
        .status(400)
        .json({ success: false, error: "Phone number is required" });
    }

    const chromeProfilePath = getChromeProfile();

    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        `--user-data-dir=${chromeProfilePath}`,
        "--profile-directory=Default",
        "--start-maximized",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // Try session restore
    if (await restoreBrowserState(page, phoneNumber)) {
      const currentUrl = await page.url();
      res.json({
        success: true,
        message: "Existing session restored!",
        status: "session_restored",
        currentUrl,
      });
      responseSent = true;
      return;
    }

    // Fresh login
    await page.goto("https://business.phonepe.com/login", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await wait(3000);

    console.log("✅ Reached PhonePe Business login page");

    console.log("🔍 Looking for phone input field...");

    const phoneSelectors = [
      'input[type="tel"]',
      'input[name="mobile"]',
      'input[name="phone"]',
      "#mobile",
      '.ant-input[placeholder*="Phone"]',
      '.ant-input[placeholder*="phone"]',
    ];

    let phoneInput = null;
    for (const selector of phoneSelectors) {
      phoneInput = await page.$(selector);
      if (phoneInput) {
        console.log(`✅ Found phone input: ${selector}`);
        break;
      }
    }

    if (!phoneInput) {
      throw new Error("Could not find phone number input field");
    }

    await phoneInput.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await phoneInput.type(phoneNumber, { delay: 100 });
    console.log("✅ Phone number entered");

    await wait(1000);

    // Click Get OTP button
    let otpButton = null;
    const allButtons = await page.$$("button");
    for (const button of allButtons) {
      const text = await button.evaluate((el) => el.textContent?.trim() || "");
      if (text.includes("OTP") || text.includes("Send")) {
        otpButton = button;
        console.log("✅ Found OTP button by text");
        break;
      }
    }

    if (!otpButton) {
      throw new Error("Get OTP button not found");
    }

    await otpButton.click();
    console.log("✅ Get OTP button clicked");

    await wait(5000);

    console.log("📱 OTP sent to your phone");

    try {
      await page.waitForSelector('iframe[title="hCaptcha challenge"]', {
        timeout: 5000,
      });
      console.log(
        "⚠️ hCaptcha challenge detected. Please solve it in the browser window.",
      );
    } catch {
      console.log("No hCaptcha detected (or already solved).");
    }

    try {
      console.log("⏳ Waiting for OTP drawer...");
      await page.waitForSelector("div.ant-drawer-body", { timeout: 300000 }); // 5 minutes
      console.log("✅ OTP drawer opened.");
    } catch {
      console.log("OTP drawer not open or timeout");
    }

    await page.waitForSelector("#mobile_otp", { timeout: 100000 });
    console.log("✅ OTP input field show");

    // Store active session and start polling
    await storeActiveBrowserSession(phoneNumber, browser, page);


    console.log("OTP sent. Polling MongoDB for OTP...");

    await wait(3000);

    try {
      await pollForOTPAndSubmit(phoneNumber, page, browser);
      console.log(`✅ Auto‑login completed for ${phoneNumber}`);
    } catch (error) {
      console.error(`❌ Auto‑login failed for ${phoneNumber}:`, error.message);
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (!responseSent) {
      res.status(500).json({ success: false, error: error.message });
    }
    if (page) await page.screenshot({ path: `error_${Date.now()}.png` });
  }
});

// Manual OTP submission (still works, inserts into MongoDB)
app.post("/api/submit-otp", async (req, res) => {
  try {
    const { phoneNumber, otp } = req.body;
    if (!phoneNumber || !otp) {
      return res
        .status(400)
        .json({ success: false, error: "Phone number and OTP required" });
    }
    if (!/^\d{5}$/.test(otp)) {
      return res
        .status(400)
        .json({ success: false, error: "OTP must be 5 digits" });
    }

    // Store OTP in MongoDB (pending)
    await storeOTP(phoneNumber, otp, "pending");
    res.json({
      success: true,
      message: "OTP stored, will be auto‑filled soon",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// OTP status check
app.post("/api/otp-status", async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res
        .status(400)
        .json({ success: false, error: "Phone number required" });
    }

    const page = getActiveBrowserPage(phoneNumber);
    if (!page) {
      return res.json({ success: true, hasActiveSession: false });
    }

    const currentUrl = await page.url();
    const otpFieldExists = !!(await page.$("#mobile_otp").catch(() => null));
    res.json({
      success: true,
      hasActiveSession: true,
      isOnOtpScreen: currentUrl.includes("/login") && otpFieldExists,
      currentUrl,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Check session status from MongoDB
app.post("/api/check-session", async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber)
      return res
        .status(400)
        .json({ success: false, error: "Phone number required" });

    const session = await Session.findOne({ phoneNumber }).lean();
    if (session) {
      const hoursOld =
        (Date.now() - new Date(session.lastUsed).getTime()) / (1000 * 60 * 60);
      res.json({
        success: true,
        hasValidSession: true,
        phoneNumber,
        sessionAge: `${Math.round(hoursOld * 10) / 10} hours`,
        merchantTokens: session.merchantTokens?.length || 0,
        loginCheck: session.loginCheck,
      });
    } else {
      res.json({ success: true, hasValidSession: false });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/',(req,res)=>{
  res.send(`server is running on ${PORT} `)
})

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
