const loginBtn = document.getElementById("loginBtn");
const supervisorBtn = document.getElementById("supervisorBtn");
const signOutBtn = document.getElementById("signOutBtn");
const searchBtn = document.getElementById("searchBtn");
const memberIdInput = document.getElementById("memberIdInput");
const sessionState = document.getElementById("sessionState");
const loadingState = document.getElementById("loadingState");
const resultPanel = document.getElementById("resultPanel");
const noticePanel = document.getElementById("noticePanel");
const noticeText = document.getElementById("noticeText");
const memberName = document.getElementById("memberName");
const memberStatus = document.getElementById("memberStatus");
const savingsBalance = document.getElementById("savingsBalance");
const checkingBalance = document.getElementById("checkingBalance");
const resultCode = document.getElementById("resultCode");
const banner = document.getElementById("banner");
const interstitialPanel = document.getElementById("interstitialPanel");
const acknowledgeBtn = document.getElementById("acknowledgeBtn");
const openSubAccountBtn = document.getElementById("openSubAccountBtn");
const subAccountPanel = document.getElementById("subAccountPanel");
const productTypeInput = document.getElementById("productTypeInput");
const openingAmountInput = document.getElementById("openingAmountInput");
const submitSubAccountBtn = document.getElementById("submitSubAccountBtn");
const confirmationPanel = document.getElementById("confirmationPanel");
const confirmationNumber = document.getElementById("confirmationNumber");
const confirmedProduct = document.getElementById("confirmedProduct");
const confirmedAmount = document.getElementById("confirmedAmount");

const tenant = new URLSearchParams(window.location.search).get("tenant") ?? "base";
let acknowledged = tenant !== "westside";

if (tenant === "westside") {
  banner.textContent = "Westside Credit Union — Member Servicing (Terminal 04)";
  document.title = "Westside CU Member Servicing";
  searchBtn.textContent = "Find Member";
  interstitialPanel.classList.remove("hidden");
}

const members = {
  1001: { name: "Ava Martin", status: "Active", savings: "$4,230.91", checking: "$812.40" },
  12345: { name: "Jordan Hale", status: "Active", savings: "$18,640.55", checking: "$2,104.00" },
  2002: { name: "Noah Davis", status: "Active", savings: "$895.22", checking: "$120.00" },
  3003: { name: "Priya Shah", status: "Active", savings: "$6,410.00", checking: "$3,002.18" },
  4004: { name: "Ruth Alvarez", status: "Restricted", savings: "$58,900.00", checking: "$1,250.00" },
  5005: { name: "Mia Okafor", status: "Active", savings: "$2,145.60", checking: "$640.10" },
  6006: { name: "Iris Chen", status: "Active", savings: "$12,004.10", checking: "$4,880.00" },
  7007: { name: "Leo Park", status: "Active", savings: "$310.75", checking: "$55.00" },
  9009: { name: "Closed Estate", status: "Closed", savings: "$0.00", checking: "$0.00" },
};

const PRODUCTS = ["Money Market", "Share Certificate", "Checking"];

const scenarios = {
  4004: "permission",
  5005: "session",
  6006: "slow",
  7007: "dialog",
  8008: "apperror",
};

const operators = { teller: "teller04", supervisor: "super01" };

let role = null;
let sessionExpiryUsed = false;
let currentMemberId = null;

function hideAllResults() {
  resultPanel.classList.add("hidden");
  subAccountPanel.classList.add("hidden");
  confirmationPanel.classList.add("hidden");
  openSubAccountBtn.classList.add("hidden");
}

function showNotice(message) {
  hideAllResults();
  noticePanel.classList.remove("hidden");
  noticeText.textContent = message;
}

function showResult(member, code) {
  noticePanel.classList.add("hidden");
  confirmationPanel.classList.add("hidden");
  subAccountPanel.classList.add("hidden");
  resultPanel.classList.remove("hidden");
  memberName.textContent = member.name;
  memberStatus.textContent = member.status;
  savingsBalance.textContent = member.savings;
  checkingBalance.textContent = member.checking;
  resultCode.textContent = code;
  if (code === "OK") {
    openSubAccountBtn.classList.remove("hidden");
  } else {
    openSubAccountBtn.classList.add("hidden");
  }
}

function setRole(next) {
  role = next;
  sessionState.textContent = next
    ? `Signed in as ${operators[next]} (${next})`
    : "Not signed in";
  loginBtn.textContent = next === "teller" ? "Signed in as Teller" : "Login as Teller";
  supervisorBtn.textContent =
    next === "supervisor" ? "Signed in as Supervisor" : "Login as Supervisor";
}

acknowledgeBtn.addEventListener("click", () => {
  acknowledged = true;
  interstitialPanel.classList.add("hidden");
});

loginBtn.addEventListener("click", () => {
  setRole("teller");
  noticePanel.classList.add("hidden");
});

supervisorBtn.addEventListener("click", () => {
  setRole("supervisor");
  noticePanel.classList.add("hidden");
});

signOutBtn.addEventListener("click", () => {
  setRole(null);
  currentMemberId = null;
  hideAllResults();
  noticePanel.classList.add("hidden");
});

searchBtn.addEventListener("click", () => {
  if (!acknowledged) {
    showNotice("Validation error: acknowledge the compliance notice before searching.");
    return;
  }
  if (!role) {
    showNotice("Session expired. Please sign in again before searching.");
    return;
  }

  const memberId = (memberIdInput.value || "").trim();
  if (!/^\d+$/.test(memberId)) {
    showNotice("Validation error: Member ID must be numeric.");
    return;
  }

  const scenario = scenarios[memberId];
  if (scenario === "permission" && role !== "supervisor") {
    showNotice(
      "Permission denied: your role cannot view this member record. A supervisor must sign in.",
    );
    return;
  }
  if (scenario === "session" && !sessionExpiryUsed) {
    sessionExpiryUsed = true;
    setRole(null);
    currentMemberId = null;
    showNotice("Session expired. Please sign in again before searching.");
    return;
  }
  if (scenario === "apperror") {
    showNotice("Unexpected application error (ref TX-500). Contact the core team.");
    return;
  }
  if (scenario === "dialog") {
    window.alert("Member record is flagged for review. Proceeding in read-only mode.");
  }

  const render = () => {
    const member = members[memberId];
    if (!member) {
      currentMemberId = null;
      showResult(
        { name: "N/A", status: "N/A", savings: "N/A", checking: "N/A" },
        "MEMBER_NOT_FOUND",
      );
      return;
    }
    currentMemberId = memberId;
    showResult(member, "OK");
  };

  if (scenario === "slow") {
    hideAllResults();
    noticePanel.classList.add("hidden");
    loadingState.classList.remove("hidden");
    setTimeout(() => {
      loadingState.classList.add("hidden");
      render();
    }, 2500);
    return;
  }
  render();
});

openSubAccountBtn.addEventListener("click", () => {
  const member = members[currentMemberId];
  if (!member) {
    showNotice("Validation error: look up a member before opening a sub-account.");
    return;
  }
  if (member.status === "Closed") {
    showNotice("Permission denied: closed memberships cannot open a new sub-account.");
    return;
  }
  noticePanel.classList.add("hidden");
  confirmationPanel.classList.add("hidden");
  subAccountPanel.classList.remove("hidden");
});

submitSubAccountBtn.addEventListener("click", () => {
  const member = members[currentMemberId];
  if (!member) {
    showNotice("Validation error: look up a member before opening a sub-account.");
    return;
  }
  const product = (productTypeInput.value || "").trim();
  const amount = (openingAmountInput.value || "").trim();
  if (!PRODUCTS.includes(product)) {
    showNotice("Validation error: Product Type must be Money Market, Share Certificate, or Checking.");
    return;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
    showNotice("Validation error: Opening Amount must be a positive dollar amount.");
    return;
  }
  if (member.status === "Restricted" && role !== "supervisor") {
    showNotice("Permission denied: a supervisor must approve a sub-account on a restricted record.");
    return;
  }

  const stamp = String(Date.now()).slice(-6);
  confirmationNumber.textContent = `CU-${currentMemberId}-${stamp}`;
  confirmedProduct.textContent = product;
  confirmedAmount.textContent = `$${Number(amount).toFixed(2)}`;
  noticePanel.classList.add("hidden");
  subAccountPanel.classList.add("hidden");
  confirmationPanel.classList.remove("hidden");
});
