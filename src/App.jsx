import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";

const WALLET_NAMES = ["Wave", "Orange Money", "Cash", "Banque"];
const CATEGORIES = [
  "nourriture",
  "transport",
  "loyer",
  "télécom",
  "santé",
  "salaire",
  "business",
  "autre",
];
const EXPENSE_CATEGORIES = CATEGORIES.filter((c) => !["salaire", "business"].includes(c));
const INCOME_CATEGORIES = ["salaire", "business", "autre"];

const MONTH_FORMATTER = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });

const CATEGORY_META = {
  nourriture: { icon: "🍽️", color: "#F59E0B" },
  transport: { icon: "🚌", color: "#3B82F6" },
  loyer: { icon: "🏠", color: "#7B61FF" },
  télécom: { icon: "📶", color: "#14B8A6" },
  santé: { icon: "💊", color: "#FF6B6B" },
  salaire: { icon: "💼", color: "#00E5A0" },
  business: { icon: "📈", color: "#7B61FF" },
  autre: { icon: "📦", color: "#8892AA" },
};

const WALLET_META = {
  Wave: { icon: "🌊", color: "#3B82F6" },
  "Orange Money": { icon: "🟠", color: "#F97316" },
  Cash: { icon: "💵", color: "#00E5A0" },
  Banque: { icon: "🏦", color: "#7B61FF" },
};

const DEFAULT_WALLETS = {
  Wave: 70000,
  "Orange Money": 45000,
  Cash: 25000,
  Banque: 120000,
};

const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";

const QUICK_PROMPTS = {
  analyze: "Analyse mes dépenses du mois en cours. Identifie les postes les plus élevés et propose 3 actions concrètes pour réduire les dépenses.",
  savings: "Donne-moi des conseils personnalisés pour augmenter mon épargne ce mois-ci, en tenant compte de mes revenus et dépenses actuels.",
  summary: "Fais un résumé financier clair et structuré de ma situation actuelle (soldes, flux du mois, tendances).",
  goal: "Aide-moi à atteindre mon objectif d'épargne du mois. Propose un plan étape par étape réaliste.",
};

const NAV_TABS = [
  { id: "home", label: "Accueil", icon: "⌂" },
  { id: "add", label: "Ajouter", icon: "+" },
  { id: "stats", label: "Stats", icon: "◫" },
  { id: "goal", label: "Objectif", icon: "◎" },
  { id: "ia", label: "IA", icon: "✦" },
];

const emptyData = { wallets: { ...DEFAULT_WALLETS }, transactions: [] };

function formatFcfa(value) {
  return new Intl.NumberFormat("fr-FR").format(Math.round(value)) + " FCFA";
}

function formatFcfaShort(value) {
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(1) + "M";
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(0) + "k";
  return String(Math.round(value));
}

function monthKeyFromDate(dateLike) {
  const date = new Date(dateLike);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return MONTH_FORMATTER.format(new Date(year, month - 1, 1));
}

function buildFinancialContext({ wallets, transactions, selectedMonth, goalByMonth, monthly }) {
  const goal = Number(goalByMonth[selectedMonth] || 0);
  const recentTx = transactions.slice(0, 15).map((tx) => ({
    wallet: tx.wallet,
    amount: tx.amount,
    type: tx.type,
    category: tx.category,
    date: tx.date,
  }));

  return JSON.stringify(
    {
      mois: monthLabel(selectedMonth),
      soldes_wallets: wallets,
      solde_total: Object.values(wallets).reduce((s, v) => s + v, 0),
      revenus_mois: monthly.revenus,
      depenses_mois: monthly.depenses,
      epargne_mois: monthly.epargne,
      depenses_par_categorie: monthly.byCategory,
      objectif_epargne: goal,
      progression_objectif_pct: goal > 0 ? Math.min(100, Math.round((Math.max(0, monthly.epargne) / goal) * 100)) : 0,
      transactions_recentes: recentTx,
    },
    null,
    2
  );
}

async function callClaudeChat({ apiKey, messages, systemPrompt }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || "Échec de l'API Claude. Vérifie VITE_ANTHROPIC_API_KEY.");
  }

  const payload = await response.json();
  const text = payload?.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("Réponse vide de Claude.");
  return text;
}

function App() {
  const [screen, setScreen] = useState("home");
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(emptyData);
  const [selectedMonth, setSelectedMonth] = useState(monthKeyFromDate(new Date()));
  const [form, setForm] = useState({ amount: "", wallet: "Wave", type: "dépense", category: "nourriture" });
  const [goalInput, setGoalInput] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ email: "", password: "" });
  const [authMessage, setAuthMessage] = useState("");
  const [goalByMonth, setGoalByMonth] = useState({});
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  const loadGoalsLocal = (userId) => {
    try {
      const raw = localStorage.getItem(`gesfin-goals-${userId}`);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  };

  const saveGoalsLocal = (userId, goals) => {
    localStorage.setItem(`gesfin-goals-${userId}`, JSON.stringify(goals));
  };

  const loadGoalsFromSupabase = async (userId) => {
    const { data: rows, error } = await supabase
      .from("savings_goals")
      .select("month_key,amount")
      .eq("user_id", userId);

    if (error) return loadGoalsLocal(userId);
    const goals = {};
    (rows || []).forEach((row) => {
      goals[row.month_key] = Number(row.amount);
    });
    return goals;
  };

  const saveGoalToSupabase = async (userId, monthKey, amount) => {
    const { error } = await supabase.from("savings_goals").upsert(
      { user_id: userId, month_key: monthKey, amount, updated_at: new Date().toISOString() },
      { onConflict: "user_id,month_key" }
    );
    if (error) {
      const local = { ...loadGoalsLocal(userId), [monthKey]: amount };
      saveGoalsLocal(userId, local);
    }
  };

  const loadUserData = async (userId) => {
    setLoading(true);

    const goals = await loadGoalsFromSupabase(userId);
    if (goals) setGoalByMonth(goals);

    const { data: walletRows, error: walletError } = await supabase
      .from("wallets")
      .select("name,balance")
      .eq("user_id", userId);

    if (walletError) {
      setLoading(false);
      return;
    }

    let normalizedWallets = {};
    (walletRows || []).forEach((row) => {
      normalizedWallets[row.name] = Number(row.balance || 0);
    });

    if (!walletRows || walletRows.length === 0) {
      const inserts = WALLET_NAMES.map((name) => ({
        user_id: userId,
        name,
        balance: DEFAULT_WALLETS[name],
      }));
      await supabase.from("wallets").insert(inserts);
      normalizedWallets = { ...DEFAULT_WALLETS };
    } else {
      WALLET_NAMES.forEach((name) => {
        if (normalizedWallets[name] == null) normalizedWallets[name] = 0;
      });
    }

    const { data: txRows } = await supabase
      .from("transactions")
      .select("id,wallet,amount,type,category,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    setData({
      wallets: normalizedWallets,
      transactions: (txRows || []).map((tx) => ({
        id: tx.id,
        wallet: tx.wallet,
        amount: Number(tx.amount),
        type: tx.type,
        category: tx.category,
        date: tx.created_at,
      })),
    });
    setLoading(false);
  };

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data: authData }) => {
      if (!mounted) return;
      setSession(authData.session);
      if (authData.session?.user?.id) {
        loadUserData(authData.session.user.id);
      } else {
        setLoading(false);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession?.user?.id) {
        loadUserData(nextSession.user.id);
      } else {
        setData(emptyData);
        setGoalByMonth({});
        setChatMessages([]);
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatLoading]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthMessage("");
    if (!authForm.email || !authForm.password) return;
    if (authMode === "login") {
      const { error } = await supabase.auth.signInWithPassword(authForm);
      if (error) setAuthMessage(error.message);
    } else {
      const { error } = await supabase.auth.signUp(authForm);
      if (error) {
        setAuthMessage(error.message);
      } else {
        setAuthMessage("Compte créé. Vérifie ton email si confirmation demandée.");
      }
    }
  };

  const handleAddTransaction = async (e) => {
    e.preventDefault();
    if (!session?.user?.id) return;
    const amount = Number(form.amount);
    if (!amount || amount <= 0) return;

    const transaction = {
      amount,
      wallet: form.wallet,
      type: form.type,
      category: form.category,
      user_id: session.user.id,
    };

    const sign = form.type === "revenu" ? 1 : -1;
    const nextBalance = Math.max(0, (data.wallets[form.wallet] || 0) + sign * amount);
    await supabase.from("transactions").insert(transaction);
    await supabase.from("wallets").upsert(
      { user_id: session.user.id, name: form.wallet, balance: nextBalance },
      { onConflict: "user_id,name" }
    );
    await loadUserData(session.user.id);
    setForm((prev) => ({ ...prev, amount: "" }));
    setScreen("home");
  };

  const totalBalance = useMemo(
    () => Object.values(data.wallets).reduce((sum, value) => sum + value, 0),
    [data.wallets]
  );

  const monthOptions = useMemo(() => {
    const keys = new Set([monthKeyFromDate(new Date())]);
    data.transactions.forEach((tx) => keys.add(monthKeyFromDate(tx.date)));
    return Array.from(keys).sort((a, b) => (a > b ? -1 : 1));
  }, [data.transactions]);

  const monthly = useMemo(() => {
    const sameMonth = data.transactions.filter((tx) => monthKeyFromDate(tx.date) === selectedMonth);
    const revenus = sameMonth.filter((tx) => tx.type === "revenu").reduce((sum, tx) => sum + tx.amount, 0);
    const depenses = sameMonth.filter((tx) => tx.type === "dépense").reduce((sum, tx) => sum + tx.amount, 0);
    const epargne = revenus - depenses;

    const byCategory = CATEGORIES.reduce((acc, c) => ({ ...acc, [c]: 0 }), {});
    sameMonth
      .filter((tx) => tx.type === "dépense")
      .forEach((tx) => {
        byCategory[tx.category] = (byCategory[tx.category] || 0) + tx.amount;
      });

    const byWallet = WALLET_NAMES.reduce((acc, w) => ({ ...acc, [w]: data.wallets[w] || 0 }), {});
    const maxCat = Math.max(...Object.values(byCategory), 1);
    const maxWallet = Math.max(...Object.values(byWallet), 1);

    return { revenus, depenses, epargne, byCategory, byWallet, maxCat, maxWallet };
  }, [data.transactions, data.wallets, selectedMonth]);

  const goalForMonth = Number(goalByMonth[selectedMonth] || 0);
  const goalProgress =
    goalForMonth > 0 ? Math.min(100, Math.round((Math.max(0, monthly.epargne) / goalForMonth) * 100)) : 0;

  const handleSaveGoal = async (e) => {
    e.preventDefault();
    if (!session?.user?.id) return;
    const goal = Math.max(0, Number(goalInput || 0));
    const nextGoals = { ...goalByMonth, [selectedMonth]: goal };
    setGoalByMonth(nextGoals);
    await saveGoalToSupabase(session.user.id, selectedMonth, goal);
    setGoalInput("");
  };

  const systemPrompt = useMemo(() => {
    const ctx = buildFinancialContext({
      wallets: data.wallets,
      transactions: data.transactions,
      selectedMonth,
      goalByMonth,
      monthly,
    });
    return (
      "Tu es l'assistant financier personnel de GesFin, une app de gestion de budget en FCFA (Afrique de l'Ouest). " +
      "Réponds en français, de façon concise, pratique et bienveillante. " +
      "Utilise les données financières réelles de l'utilisateur ci-dessous pour personnaliser chaque réponse. " +
      "Montants en FCFA. Ne invente pas de chiffres.\n\n" +
      "DONNÉES FINANCIÈRES:\n" +
      ctx
    );
  }, [data.wallets, data.transactions, selectedMonth, goalByMonth, monthly]);

  const sendChat = async (userText) => {
    if (!ANTHROPIC_API_KEY.trim()) {
      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "L'assistant IA n'est pas configuré. Définis VITE_ANTHROPIC_API_KEY dans un fichier .env à la racine du projet, puis redémarre le serveur de dev.",
        },
      ]);
      return;
    }
    if (!userText.trim() || chatLoading) return;

    const userMsg = { role: "user", content: userText.trim() };
    const nextMessages = [...chatMessages, userMsg];
    setChatMessages(nextMessages);
    setChatInput("");
    setChatLoading(true);

    try {
      const apiMessages = nextMessages.map((m) => ({ role: m.role, content: m.content }));
      const reply = await callClaudeChat({
        apiKey: ANTHROPIC_API_KEY,
        messages: apiMessages,
        systemPrompt,
      });
      setChatMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (error) {
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: error.message || "Erreur de connexion à Claude." },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const formCategories = form.type === "revenu" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  if (loading) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-md items-center justify-center bg-gesfin-bg">
        <div className="text-center">
          <p className="gesfin-logo text-3xl font-bold tracking-widest">GESFIN</p>
          <p className="mt-3 font-mono text-sm text-gesfin-muted">Chargement...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return <AuthScreen authMode={authMode} setAuthMode={setAuthMode} authForm={authForm} setAuthForm={setAuthForm} authMessage={authMessage} onSubmit={handleAuth} />;
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-md bg-gesfin-bg text-gesfin-text">
      <main className="space-y-4 px-4 pb-28 pt-5 animate-fade-in">
        <MonthPills selectedMonth={selectedMonth} setSelectedMonth={setSelectedMonth} monthOptions={monthOptions} />

        {screen === "home" && (
          <HomeScreen
            totalBalance={totalBalance}
            monthly={monthly}
            wallets={data.wallets}
            transactions={data.transactions}
            email={session.user.email}
            onLogout={() => supabase.auth.signOut()}
          />
        )}

        {screen === "add" && (
          <AddScreen form={form} setForm={setForm} formCategories={formCategories} onSubmit={handleAddTransaction} />
        )}

        {screen === "stats" && <StatsScreen monthly={monthly} selectedMonth={selectedMonth} />}

        {screen === "goal" && (
          <GoalScreen
            selectedMonth={selectedMonth}
            goalForMonth={goalForMonth}
            goalProgress={goalProgress}
            monthly={monthly}
            goalInput={goalInput}
            setGoalInput={setGoalInput}
            onSaveGoal={handleSaveGoal}
          />
        )}

        {screen === "ia" && (
          <IAScreen
            chatMessages={chatMessages}
            chatInput={chatInput}
            setChatInput={setChatInput}
            chatLoading={chatLoading}
            onSend={sendChat}
            onQuick={(key) => sendChat(QUICK_PROMPTS[key])}
            onClear={() => setChatMessages([])}
            chatEndRef={chatEndRef}
          />
        )}
      </main>

      <BottomNav screen={screen} setScreen={setScreen} />
    </div>
  );
}

/* ─── Auth ─── */

function AuthScreen({ authMode, setAuthMode, authForm, setAuthForm, authMessage, onSubmit }) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center bg-gesfin-bg px-5 py-10">
      <div className="mb-8 text-center">
        <h1 className="gesfin-logo text-4xl font-bold tracking-[0.2em]">GESFIN</h1>
        <p className="mt-2 text-sm text-gesfin-muted">Gestion financière intelligente</p>
      </div>

      <section className="animate-slide-up rounded-2xl border border-gesfin-border bg-gesfin-card p-6">
        <div className="flex gap-2 rounded-xl bg-gesfin-cardAlt p-1">
          {["login", "signup"].map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setAuthMode(mode)}
              className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
                authMode === mode ? "bg-gesfin-accent text-gesfin-bg" : "text-gesfin-muted"
              }`}
            >
              {mode === "login" ? "Connexion" : "Inscription"}
            </button>
          ))}
        </div>

        <form className="mt-5 space-y-3" onSubmit={onSubmit}>
          <input
            className="input-gesfin"
            type="email"
            placeholder="email@exemple.com"
            value={authForm.email}
            onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })}
            required
          />
          <input
            className="input-gesfin"
            type="password"
            placeholder="mot de passe"
            value={authForm.password}
            onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })}
            required
          />
          <button
            className="w-full rounded-xl bg-gesfin-accent py-3 font-semibold text-gesfin-bg transition hover:brightness-110"
            type="submit"
          >
            {authMode === "login" ? "Se connecter" : "Créer un compte"}
          </button>
        </form>
        {authMessage && <p className="mt-3 text-center text-xs text-gesfin-muted">{authMessage}</p>}
      </section>
    </div>
  );
}

/* ─── Accueil ─── */

function HomeScreen({ totalBalance, monthly, wallets, transactions, email, onLogout }) {
  const stats = [
    { label: "Revenus", value: monthly.revenus, color: "#00E5A0" },
    { label: "Dépenses", value: monthly.depenses, color: "#FF6B6B" },
    { label: "Épargne", value: monthly.epargne, color: "#7B61FF" },
  ];

  return (
    <>
      <header className="flex items-center justify-between">
        <h1 className="gesfin-logo text-2xl font-bold tracking-[0.15em]">GESFIN</h1>
        <button type="button" onClick={onLogout} className="text-xs text-gesfin-muted hover:text-gesfin-accent">
          Déconnexion
        </button>
      </header>

      <section className="animate-glow animate-slide-up rounded-2xl border border-gesfin-border bg-gesfin-card p-5">
        <p className="text-xs uppercase tracking-widest text-gesfin-muted">Solde total</p>
        <p className="mt-1 font-mono text-3xl font-bold leading-tight text-gesfin-text">
          {formatFcfa(totalBalance)}
        </p>
        <p className="mt-2 truncate text-xs text-gesfin-muted">{email}</p>
      </section>

      <section className="grid grid-cols-3 gap-2">
        {stats.map((s) => (
          <div key={s.label} className="animate-slide-up rounded-xl border border-gesfin-border bg-gesfin-cardAlt p-3">
            <p className="text-[10px] uppercase tracking-wide text-gesfin-muted">{s.label}</p>
            <p className="mt-1 font-mono text-xs font-bold" style={{ color: s.color }}>
              {formatFcfaShort(s.value)}
            </p>
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-gesfin-muted">Wallets</h2>
        <div className="grid grid-cols-2 gap-2">
          {WALLET_NAMES.map((name) => {
            const meta = WALLET_META[name];
            return (
              <div
                key={name}
                className="animate-slide-up rounded-xl border border-gesfin-border bg-gesfin-card p-3"
                style={{ borderLeftColor: meta.color, borderLeftWidth: 3 }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg">{meta.icon}</span>
                  <span className="text-xs text-gesfin-muted">{name}</span>
                </div>
                <p className="mt-2 font-mono text-sm font-bold" style={{ color: meta.color }}>
                  {formatFcfa(wallets[name] || 0)}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-gesfin-border bg-gesfin-card p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gesfin-muted">
          Transactions récentes
        </h2>
        <div className="space-y-2">
          {transactions.length === 0 && (
            <p className="py-4 text-center text-sm text-gesfin-muted">Aucune transaction</p>
          )}
          {transactions.slice(0, 8).map((tx) => (
            <TransactionRow key={tx.id} tx={tx} />
          ))}
        </div>
      </section>
    </>
  );
}

/* ─── Ajouter ─── */

function AddScreen({ form, setForm, formCategories, onSubmit }) {
  const setType = (type) => {
    const defaultCat = type === "revenu" ? "salaire" : "nourriture";
    setForm((prev) => ({ ...prev, type, category: defaultCat }));
  };

  return (
    <section className="animate-slide-up rounded-2xl border border-gesfin-border bg-gesfin-card p-5">
      <h2 className="mb-4 text-lg font-bold">Nouvelle transaction</h2>

      <form className="space-y-5" onSubmit={onSubmit}>
        <div className="flex rounded-xl bg-gesfin-cardAlt p-1">
          {["dépense", "revenu"].map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setType(type)}
              className={`flex-1 rounded-lg py-2.5 text-sm font-semibold capitalize transition ${
                form.type === type
                  ? type === "dépense"
                    ? "bg-gesfin-red text-white"
                    : "bg-gesfin-accent text-gesfin-bg"
                  : "text-gesfin-muted"
              }`}
            >
              {type}
            </button>
          ))}
        </div>

        <div>
          <label className="mb-2 block text-xs uppercase tracking-widest text-gesfin-muted">Montant (FCFA)</label>
          <input
            className="input-gesfin text-xl"
            type="number"
            min="1"
            placeholder="0"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            required
          />
        </div>

        <div>
          <label className="mb-2 block text-xs uppercase tracking-widest text-gesfin-muted">Wallet</label>
          <div className="flex flex-wrap gap-2">
            {WALLET_NAMES.map((wallet) => {
              const meta = WALLET_META[wallet];
              const active = form.wallet === wallet;
              return (
                <button
                  key={wallet}
                  type="button"
                  onClick={() => setForm({ ...form, wallet })}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                    active ? "border-transparent text-gesfin-bg" : "border-gesfin-border text-gesfin-muted"
                  }`}
                  style={active ? { background: meta.color } : {}}
                >
                  {meta.icon} {wallet}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-xs uppercase tracking-widest text-gesfin-muted">Catégorie</label>
          <div className="flex flex-wrap gap-2">
            {formCategories.map((category) => {
              const meta = CATEGORY_META[category];
              const active = form.category === category;
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => setForm({ ...form, category })}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition ${
                    active ? "border-transparent text-white" : "border-gesfin-border text-gesfin-muted"
                  }`}
                  style={active ? { background: meta.color } : {}}
                >
                  {meta.icon} {category}
                </button>
              );
            })}
          </div>
        </div>

        <button
          className="w-full rounded-xl bg-gesfin-accent py-3 font-bold text-gesfin-bg transition hover:brightness-110"
          type="submit"
        >
          Enregistrer
        </button>
      </form>
    </section>
  );
}

/* ─── Stats ─── */

function StatsScreen({ monthly, selectedMonth }) {
  const kpis = [
    { label: "Revenus", value: monthly.revenus, color: "#00E5A0" },
    { label: "Dépenses", value: monthly.depenses, color: "#FF6B6B" },
    { label: "Épargne", value: monthly.epargne, color: "#7B61FF" },
  ];

  const expenseCats = CATEGORIES.filter((c) => (monthly.byCategory[c] || 0) > 0 || EXPENSE_CATEGORIES.includes(c));

  return (
    <>
      <h2 className="text-lg font-bold">Stats — {monthLabel(selectedMonth)}</h2>

      <section className="grid grid-cols-3 gap-2">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-xl border border-gesfin-border bg-gesfin-card p-3 text-center">
            <p className="text-[10px] uppercase text-gesfin-muted">{k.label}</p>
            <p className="mt-1 font-mono text-xs font-bold" style={{ color: k.color }}>
              {formatFcfaShort(k.value)}
            </p>
          </div>
        ))}
      </section>

      <Card title="Dépenses par catégorie">
        <div className="space-y-3">
          {expenseCats.map((category) => {
            const value = monthly.byCategory[category] || 0;
            const percent = monthly.depenses > 0 ? Math.round((value / monthly.depenses) * 100) : 0;
            const barWidth = monthly.maxCat > 0 ? Math.round((value / monthly.maxCat) * 100) : 0;
            const meta = CATEGORY_META[category];
            if (value === 0 && !EXPENSE_CATEGORIES.includes(category)) return null;
            return (
              <div key={category}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 capitalize">
                    <span>{meta.icon}</span>
                    {category}
                  </span>
                  <span className="font-mono text-gesfin-muted">
                    {formatFcfaShort(value)} · {percent}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-gesfin-border">
                  <div
                    className="h-2 rounded-full transition-all duration-500"
                    style={{ width: `${barWidth}%`, background: meta.color }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Répartition par wallet">
        <div className="space-y-3">
          {WALLET_NAMES.map((wallet) => {
            const value = monthly.byWallet[wallet] || 0;
            const barWidth = monthly.maxWallet > 0 ? Math.round((value / monthly.maxWallet) * 100) : 0;
            const meta = WALLET_META[wallet];
            return (
              <div key={wallet}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5">
                    <span>{meta.icon}</span>
                    {wallet}
                  </span>
                  <span className="font-mono text-gesfin-muted">{formatFcfa(value)}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-gesfin-border">
                  <div
                    className="h-2 rounded-full transition-all duration-500"
                    style={{ width: `${barWidth}%`, background: meta.color }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}

/* ─── Objectif ─── */

function GoalScreen({ selectedMonth, goalForMonth, goalProgress, monthly, goalInput, setGoalInput, onSaveGoal }) {
  return (
    <>
      <h2 className="text-lg font-bold">Objectif — {monthLabel(selectedMonth)}</h2>

      <section className="animate-slide-up rounded-2xl border border-gesfin-border bg-gesfin-card p-5">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-gesfin-muted">Progression</p>
            <p className="mt-1 font-mono text-4xl font-bold text-gesfin-accent">{goalProgress}%</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gesfin-muted">Épargne actuelle</p>
            <p className="font-mono text-sm font-bold text-gesfin-text">
              {formatFcfa(Math.max(0, monthly.epargne))}
            </p>
          </div>
        </div>

        <div className="mt-5 h-3 overflow-hidden rounded-full bg-gesfin-border">
          <div
            className="h-3 rounded-full bg-gradient-to-r from-gesfin-accent to-gesfin-purple transition-all duration-700"
            style={{ width: `${goalProgress}%` }}
          />
        </div>

        <div className="mt-4 flex justify-between text-xs text-gesfin-muted">
          <span>Objectif : {formatFcfa(goalForMonth)}</span>
          <span>Reste : {formatFcfa(Math.max(0, goalForMonth - Math.max(0, monthly.epargne)))}</span>
        </div>
      </section>

      <Card title="Définir l'objectif">
        <form className="space-y-3" onSubmit={onSaveGoal}>
          <input
            className="input-gesfin"
            type="number"
            min="0"
            placeholder="Ex: 50000"
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
          />
          <button
            className="w-full rounded-xl bg-gesfin-purple py-3 font-semibold text-white transition hover:brightness-110"
            type="submit"
          >
            Enregistrer l'objectif
          </button>
        </form>
        {goalForMonth > 0 && (
          <p className="mt-3 text-center text-xs text-gesfin-muted">
            Objectif actuel : <span className="font-mono text-gesfin-accent">{formatFcfa(goalForMonth)}</span>
          </p>
        )}
      </Card>
    </>
  );
}

/* ─── IA ─── */

function IAScreen({ chatMessages, chatInput, setChatInput, chatLoading, onSend, onQuick, onClear, chatEndRef }) {
  const quickButtons = [
    { key: "analyze", label: "Analyser mes dépenses", icon: "📊" },
    { key: "savings", label: "Conseils épargne", icon: "💰" },
    { key: "summary", label: "Résumé financier", icon: "📋" },
    { key: "goal", label: "Atteindre objectif", icon: "🎯" },
  ];

  return (
    <>
      <header>
        <h2 className="text-lg font-bold">Assistant IA</h2>
        <p className="text-xs text-gesfin-muted">Propulsé par Claude · données synchronisées</p>
      </header>

      <div className="grid grid-cols-2 gap-2">
        {quickButtons.map((btn) => (
          <button
            key={btn.key}
            type="button"
            disabled={chatLoading}
            onClick={() => onQuick(btn.key)}
            className="rounded-xl border border-gesfin-border bg-gesfin-card px-3 py-2.5 text-left text-xs transition hover:border-gesfin-accent disabled:opacity-50"
          >
            <span className="mr-1">{btn.icon}</span>
            {btn.label}
          </button>
        ))}
      </div>

      <section className="rounded-2xl border border-gesfin-border bg-gesfin-card">
        <div className="flex items-center justify-between border-b border-gesfin-border px-4 py-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-gesfin-muted">Conversation</span>
          {chatMessages.length > 0 && (
            <button type="button" onClick={onClear} className="text-[10px] text-gesfin-red hover:underline">
              Effacer
            </button>
          )}
        </div>

        <div className="hide-scrollbar max-h-72 space-y-3 overflow-y-auto p-4">
          {chatMessages.length === 0 && (
            <p className="py-6 text-center text-sm text-gesfin-muted">
              Pose une question ou utilise un bouton rapide ci-dessus.
            </p>
          )}
          {chatMessages.map((msg, i) => (
            <div
              key={i}
              className={`rounded-xl px-3 py-2 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "ml-6 bg-gesfin-accent/15 text-gesfin-text"
                  : "mr-4 border border-gesfin-border bg-gesfin-cardAlt text-gesfin-text"
              }`}
            >
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-gesfin-muted">
                {msg.role === "user" ? "Vous" : "Claude"}
              </p>
              <p className="whitespace-pre-wrap">{msg.content}</p>
            </div>
          ))}
          {chatLoading && (
            <div className="mr-4 rounded-xl border border-gesfin-border bg-gesfin-cardAlt px-3 py-2 text-sm text-gesfin-muted">
              <span className="inline-block animate-pulse">Claude réfléchit...</span>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <form
          className="flex gap-2 border-t border-gesfin-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSend(chatInput);
          }}
        >
          <input
            className="input-gesfin flex-1 text-sm"
            placeholder="Pose ta question..."
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            disabled={chatLoading}
          />
          <button
            type="submit"
            disabled={chatLoading || !chatInput.trim()}
            className="rounded-xl bg-gesfin-accent px-4 py-2 font-bold text-gesfin-bg disabled:opacity-40"
          >
            →
          </button>
        </form>
      </section>
    </>
  );
}

/* ─── Shared components ─── */

function TransactionRow({ tx }) {
  const meta = CATEGORY_META[tx.category] || { icon: "💸", color: "#8892AA" };
  const isIncome = tx.type === "revenu";

  return (
    <div className="flex items-center justify-between rounded-xl border border-gesfin-border bg-gesfin-cardAlt px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-lg text-base"
          style={{ background: `${meta.color}22` }}
        >
          {meta.icon}
        </span>
        <div>
          <p className="text-sm font-medium capitalize">{tx.category}</p>
          <p className="text-[11px] text-gesfin-muted">
            {tx.wallet} · {new Date(tx.date).toLocaleDateString("fr-FR")}
          </p>
        </div>
      </div>
      <p className={`font-mono text-sm font-bold ${isIncome ? "text-gesfin-accent" : "text-gesfin-red"}`}>
        {isIncome ? "+" : "−"}
        {formatFcfaShort(tx.amount)}
      </p>
    </div>
  );
}

function MonthPills({ selectedMonth, setSelectedMonth, monthOptions }) {
  return (
    <div className="hide-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {monthOptions.map((month) => (
        <button
          key={month}
          type="button"
          onClick={() => setSelectedMonth(month)}
          className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition ${
            month === selectedMonth
              ? "border-gesfin-accent bg-gesfin-accent/15 text-gesfin-accent"
              : "border-gesfin-border bg-gesfin-card text-gesfin-muted hover:text-gesfin-text"
          }`}
        >
          {monthLabel(month)}
        </button>
      ))}
    </div>
  );
}

function Card({ title, children }) {
  return (
    <section className="animate-slide-up rounded-2xl border border-gesfin-border bg-gesfin-card p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gesfin-muted">{title}</h3>
      {children}
    </section>
  );
}

function BottomNav({ screen, setScreen }) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 mx-auto w-full max-w-md border-t border-gesfin-border bg-gesfin-bg/95 backdrop-blur-md">
      <div className="flex">
        {NAV_TABS.map((tab) => {
          const active = screen === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setScreen(tab.id)}
              className="flex flex-1 flex-col items-center py-2.5 transition"
            >
              <span
                className={`text-base leading-none ${active ? "text-gesfin-accent" : "text-gesfin-muted"}`}
                style={active ? { textShadow: "0 0 12px rgba(0,229,160,0.5)" } : {}}
              >
                {tab.icon}
              </span>
              <span className={`mt-0.5 text-[10px] font-medium ${active ? "text-gesfin-accent" : "text-gesfin-muted"}`}>
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export default App;
