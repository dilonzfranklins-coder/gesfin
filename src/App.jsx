import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";

const WALLET_NAMES = ["Wave", "Orange Money", "Cash", "Banque"];
const CATEGORIES = ["nourriture", "transport", "loyer", "télécom", "santé"];
const MONTH_FORMATTER = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });
const CATEGORY_META = {
  nourriture: { icon: "🍽️", color: "#F59E0B" },
  transport: { icon: "🚌", color: "#3B82F6" },
  loyer: { icon: "🏠", color: "#A855F7" },
  télécom: { icon: "📶", color: "#14B8A6" },
  santé: { icon: "💊", color: "#EF4444" },
};
const DEFAULT_WALLETS = {
  Wave: 70000,
  "Orange Money": 45000,
  Cash: 25000,
  Banque: 120000,
};

const emptyData = { wallets: { ...DEFAULT_WALLETS }, transactions: [] };

function formatFcfa(value) {
  return new Intl.NumberFormat("fr-FR").format(value) + " FCFA";
}

function monthKeyFromDate(dateLike) {
  const date = new Date(dateLike);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return MONTH_FORMATTER.format(new Date(year, month - 1, 1));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Impossible de lire l'image."));
    reader.readAsDataURL(file);
  });
}

async function extractBalanceFromImage({ dataUrl, apiKey, mediaType }) {
  const base64 = dataUrl.split(",")[1];
  if (!base64) throw new Error("Image invalide.");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-latest",
      max_tokens: 220,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType || "image/jpeg", data: base64 },
            },
            {
              type: "text",
              text:
                "Lis cette capture d'ecran de solde mobile money. " +
                'Reponds STRICTEMENT en JSON: {"wallet":"Wave|Orange Money|unknown","balance":number}. ' +
                "Le champ balance doit etre un nombre entier FCFA sans espaces. Si absent mets 0.",
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) throw new Error("Echec API Claude Vision. Verifie la cle API.");

  const payload = await response.json();
  const text = payload?.content?.[0]?.text || "";
  const cleaned = text.replace(/```json|```/g, "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Reponse Claude non exploitable.");
  }

  const wallet = parsed?.wallet === "Wave" || parsed?.wallet === "Orange Money" ? parsed.wallet : "unknown";
  const balance = Math.max(0, Number(parsed?.balance || 0));
  return { wallet, balance };
}

function App() {
  const [screen, setScreen] = useState("dashboard");
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
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [scannerState, setScannerState] = useState({ loading: false, message: "" });
  const fileInputRef = useRef(null);

  const saveLocalPrefs = (userId, nextGoals, nextApiKey) => {
    const payload = { savingsGoals: nextGoals, claudeApiKey: nextApiKey };
    localStorage.setItem(`gesfin-prefs-${userId}`, JSON.stringify(payload));
  };

  const loadLocalPrefs = (userId) => {
    try {
      const raw = localStorage.getItem(`gesfin-prefs-${userId}`);
      if (!raw) return { savingsGoals: {}, claudeApiKey: "" };
      const parsed = JSON.parse(raw);
      return {
        savingsGoals: parsed?.savingsGoals || {},
        claudeApiKey: parsed?.claudeApiKey || "",
      };
    } catch {
      return { savingsGoals: {}, claudeApiKey: "" };
    }
  };

  const loadUserData = async (userId) => {
    setLoading(true);
    const prefs = loadLocalPrefs(userId);
    setGoalByMonth(prefs.savingsGoals);
    setClaudeApiKey(prefs.claudeApiKey);

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
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

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
    setScreen("dashboard");
  };

  const totalBalance = useMemo(() => Object.values(data.wallets).reduce((sum, value) => sum + value, 0), [data.wallets]);

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

    const maxCat = Math.max(...Object.values(byCategory), 1);
    const donutData = CATEGORIES.map((category) => ({
      category,
      value: byCategory[category] || 0,
      color: CATEGORY_META[category].color,
    })).filter((item) => item.value > 0);

    return { revenus, depenses, epargne, byCategory, maxCat, donutData };
  }, [data.transactions, selectedMonth]);

  const goalForMonth = Number(goalByMonth[selectedMonth] || 0);
  const goalProgress = goalForMonth > 0 ? Math.min(100, Math.round((Math.max(0, monthly.epargne) / goalForMonth) * 100)) : 0;

  const handleSaveGoal = (e) => {
    e.preventDefault();
    if (!session?.user?.id) return;
    const goal = Math.max(0, Number(goalInput || 0));
    const nextGoals = { ...goalByMonth, [selectedMonth]: goal };
    setGoalByMonth(nextGoals);
    saveLocalPrefs(session.user.id, nextGoals, claudeApiKey);
    setGoalInput("");
  };

  const handleApiKeyChange = (value) => {
    const next = value.trim();
    setClaudeApiKey(next);
    if (session?.user?.id) saveLocalPrefs(session.user.id, goalByMonth, next);
  };

  const handleScanClick = () => {
    if (!claudeApiKey) {
      setScannerState({ loading: false, message: "Ajoute d'abord ta clé API Claude Vision." });
      return;
    }
    fileInputRef.current?.click();
  };

  const handleScanImage = async (event) => {
    if (!session?.user?.id) return;
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setScannerState({ loading: true, message: "Analyse de l'image en cours..." });
    try {
      const dataUrl = await fileToDataUrl(file);
      const { wallet, balance } = await extractBalanceFromImage({
        dataUrl,
        apiKey: claudeApiKey,
        mediaType: file.type || "image/jpeg",
      });

      if (wallet === "unknown" || !WALLET_NAMES.includes(wallet)) {
        throw new Error("Wallet non reconnu. Utilise une capture Wave ou Orange Money lisible.");
      }

      await supabase.from("wallets").upsert(
        { user_id: session.user.id, name: wallet, balance },
        { onConflict: "user_id,name" }
      );
      await loadUserData(session.user.id);
      setScannerState({ loading: false, message: `Solde ${wallet} mis à jour: ${formatFcfa(balance)}.` });
    } catch (error) {
      setScannerState({ loading: false, message: error.message || "Erreur pendant le scan." });
    }
  };

  if (loading) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-md items-center justify-center bg-[#0F0F0F] text-white">
        Chargement...
      </div>
    );
  }

  if (!session) {
    return (
      <div className="mx-auto min-h-screen w-full max-w-md bg-[#0F0F0F] px-4 py-8 text-white">
        <section className="rounded-2xl border border-[#2A2A2A] bg-[#1A1A1A] p-5 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
          <h1 className="text-2xl font-extrabold">GesFin</h1>
          <p className="mt-1 text-sm text-[#888888]">Connexion sécurisée avec Supabase</p>
          <div className="mt-4 flex gap-2">
            <button
              className={`rounded-full px-4 py-1 text-sm ${authMode === "login" ? "bg-[#1D9E75] text-white" : "bg-[#121212] text-[#888888]"}`}
              onClick={() => setAuthMode("login")}
              type="button"
            >
              Connexion
            </button>
            <button
              className={`rounded-full px-4 py-1 text-sm ${authMode === "signup" ? "bg-[#1D9E75] text-white" : "bg-[#121212] text-[#888888]"}`}
              onClick={() => setAuthMode("signup")}
              type="button"
            >
              Inscription
            </button>
          </div>
          <form className="mt-4 space-y-3" onSubmit={handleAuth}>
            <input
              className="input-dark"
              type="email"
              placeholder="email"
              value={authForm.email}
              onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })}
              required
            />
            <input
              className="input-dark"
              type="password"
              placeholder="mot de passe"
              value={authForm.password}
              onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })}
              required
            />
            <button className="w-full rounded-xl bg-[#1D9E75] py-2 font-semibold text-white" type="submit">
              {authMode === "login" ? "Se connecter" : "Créer un compte"}
            </button>
          </form>
          {authMessage && <p className="mt-3 text-xs text-[#888888]">{authMessage}</p>}
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-md bg-[#0F0F0F] text-white">
      <main className="space-y-4 px-4 pb-24 pt-6 animate-fade-in">
        <HeaderCard totalBalance={totalBalance} />
        <div className="flex items-center justify-between rounded-xl border border-[#2A2A2A] bg-[#1A1A1A] px-3 py-2 text-xs text-[#888888]">
          <span>{session.user.email}</span>
          <button className="text-[#1D9E75]" onClick={() => supabase.auth.signOut()} type="button">
            Déconnexion
          </button>
        </div>

        <MonthPills selectedMonth={selectedMonth} setSelectedMonth={setSelectedMonth} monthOptions={monthOptions} />

        {screen === "dashboard" && (
          <>
            <StatsRow monthly={monthly} />

            <PremiumCard title="Dépenses par catégorie">
              <DonutChart data={monthly.donutData} total={monthly.depenses} />
            </PremiumCard>

            <PremiumCard title="Wallets">
              <div className="grid grid-cols-2 gap-2">
                {WALLET_NAMES.map((wallet) => (
                  <div key={wallet} className="rounded-xl border border-[#2A2A2A] bg-[#121212] p-3">
                    <p className="text-xs text-[#888888]">{wallet}</p>
                    <p className="mt-1 text-sm font-bold">{formatFcfa(data.wallets[wallet] || 0)}</p>
                  </div>
                ))}
              </div>
            </PremiumCard>

            <PremiumCard title="Transactions récentes">
              <div className="space-y-2">
                {data.transactions.slice(0, 6).map((tx) => (
                  <TransactionRow key={tx.id} tx={tx} />
                ))}
              </div>
            </PremiumCard>

            <PremiumCard title="Scanner screenshot">
              <label className="mb-2 block text-xs text-[#888888]">Clé API Claude Vision</label>
              <input
                className="mb-3 w-full rounded-xl border border-[#2A2A2A] bg-[#121212] px-3 py-2 text-sm text-white outline-none focus:border-[#1D9E75]"
                type="password"
                placeholder="sk-ant-..."
                value={claudeApiKey}
                onChange={(e) => handleApiKeyChange(e.target.value)}
              />
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleScanImage} />
              <button
                type="button"
                onClick={handleScanClick}
                disabled={scannerState.loading}
                className="w-full rounded-xl bg-[#1D9E75] py-2 font-semibold text-white transition hover:brightness-110 disabled:opacity-70"
              >
                {scannerState.loading ? "Scan en cours..." : "Scanner mon solde"}
              </button>
              {scannerState.message && <p className="mt-2 text-xs text-[#888888]">{scannerState.message}</p>}
            </PremiumCard>
          </>
        )}

        {screen === "add" && (
          <PremiumCard title="Ajouter une transaction">
            <form className="space-y-3" onSubmit={handleAddTransaction}>
              <Field label="Montant (FCFA)">
                <input
                  className="input-dark"
                  type="number"
                  min="1"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  required
                />
              </Field>
              <Field label="Wallet">
                <select className="input-dark" value={form.wallet} onChange={(e) => setForm({ ...form, wallet: e.target.value })}>
                  {WALLET_NAMES.map((wallet) => (
                    <option key={wallet} value={wallet}>
                      {wallet}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Type">
                <select className="input-dark" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  <option value="revenu">revenu</option>
                  <option value="dépense">dépense</option>
                </select>
              </Field>
              <Field label="Catégorie">
                <select
                  className="input-dark"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                >
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </Field>
              <button className="w-full rounded-xl bg-[#1D9E75] py-2 font-semibold text-white transition hover:brightness-110" type="submit">
                Enregistrer
              </button>
            </form>
          </PremiumCard>
        )}

        {screen === "stats" && (
          <>
            <StatsRow monthly={monthly} />
            <PremiumCard title="Répartition des dépenses">
              <DonutChart data={monthly.donutData} total={monthly.depenses} />
            </PremiumCard>
            <PremiumCard title="Progression par catégorie">
              <div className="space-y-3">
                {CATEGORIES.map((category) => {
                  const value = monthly.byCategory[category] || 0;
                  const percent = Math.round((value / monthly.maxCat) * 100);
                  return (
                    <div key={category}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="flex items-center gap-2 capitalize">
                          <span>{CATEGORY_META[category].icon}</span>
                          <span>{category}</span>
                        </span>
                        <span>{formatFcfa(value)}</span>
                      </div>
                      <div className="h-2 rounded-full bg-[#2A2A2A]">
                        <div className="h-2 rounded-full transition-all" style={{ width: `${percent}%`, background: CATEGORY_META[category].color }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </PremiumCard>
          </>
        )}

        {screen === "goal" && (
          <>
            <PremiumCard title="Objectif d'épargne">
              <p className="mb-3 text-sm text-[#888888]">Définis ton objectif pour {monthLabel(selectedMonth)}.</p>
              <form className="space-y-3" onSubmit={handleSaveGoal}>
                <input
                  className="input-dark"
                  type="number"
                  min="0"
                  placeholder="Ex: 50 000"
                  value={goalInput}
                  onChange={(e) => setGoalInput(e.target.value)}
                />
                <button className="w-full rounded-xl bg-[#1D9E75] py-2 font-semibold text-white transition hover:brightness-110" type="submit">
                  Enregistrer l'objectif
                </button>
              </form>
            </PremiumCard>

            <PremiumCard title="Progression">
              <p className="text-xs text-[#888888]">Objectif</p>
              <p className="text-2xl font-extrabold">{formatFcfa(goalForMonth)}</p>
              <div className="mt-4">
                <div className="mb-1 flex justify-between text-xs text-[#888888]">
                  <span>Épargne actuelle</span>
                  <span>{formatFcfa(Math.max(0, monthly.epargne))}</span>
                </div>
                <div className="h-3 rounded-full bg-[#2A2A2A]">
                  <div className="h-3 rounded-full bg-[#1D9E75] transition-all" style={{ width: `${goalProgress}%` }} />
                </div>
                <p className="mt-2 text-xs text-[#888888]">{goalProgress}% de l'objectif atteint</p>
              </div>
            </PremiumCard>
          </>
        )}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 mx-auto flex w-full max-w-md border-t border-[#2A2A2A] bg-[#111111]/95 backdrop-blur">
        <TabButton active={screen === "dashboard"} onClick={() => setScreen("dashboard")} label="Dashboard" icon="🏦" />
        <TabButton active={screen === "add"} onClick={() => setScreen("add")} label="Ajout" icon="➕" />
        <TabButton active={screen === "stats"} onClick={() => setScreen("stats")} label="Stats" icon="📊" />
        <TabButton active={screen === "goal"} onClick={() => setScreen("goal")} label="Objectif" icon="🎯" />
      </nav>
    </div>
  );
}

function HeaderCard({ totalBalance }) {
  return (
    <section className="animate-slide-up rounded-2xl border border-[#2A2A2A] bg-[#1A1A1A] p-5 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
      <p className="text-sm text-[#888888]">Bonsoir, Awa 👋</p>
      <p className="mt-2 text-xs uppercase tracking-wide text-[#888888]">Solde total</p>
      <h1 className="mt-1 text-4xl font-extrabold leading-tight">{formatFcfa(totalBalance)}</h1>
    </section>
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
          className={`whitespace-nowrap rounded-full border px-4 py-2 text-xs font-semibold transition ${
            month === selectedMonth
              ? "border-[#1D9E75] bg-[#1D9E75] text-white"
              : "border-[#2A2A2A] bg-[#1A1A1A] text-[#888888] hover:text-white"
          }`}
        >
          {monthLabel(month)}
        </button>
      ))}
    </div>
  );
}

function StatsRow({ monthly }) {
  const items = [
    { label: "Revenus", value: monthly.revenus, color: "#22C55E" },
    { label: "Dépenses", value: monthly.depenses, color: "#EF4444" },
    { label: "Épargne", value: monthly.epargne, color: "#1D9E75" },
  ];

  return (
    <section className="grid grid-cols-3 gap-2">
      {items.map((item) => (
        <div
          key={item.label}
          className="animate-slide-up rounded-2xl border border-[#2A2A2A] bg-[#1A1A1A] p-3 shadow-[0_8px_20px_rgba(0,0,0,0.25)]"
        >
          <p className="text-[11px] text-[#888888]">{item.label}</p>
          <p className="mt-1 text-sm font-bold" style={{ color: item.color }}>
            {formatFcfa(item.value)}
          </p>
        </div>
      ))}
    </section>
  );
}

function DonutChart({ data, total }) {
  const normalized = total > 0 ? data : [];
  let progress = 0;
  const segments = normalized
    .map((item) => {
      const start = progress;
      const size = (item.value / total) * 360;
      progress += size;
      return `${item.color} ${start}deg ${progress}deg`;
    })
    .join(", ");
  const background = segments || "#2A2A2A 0deg 360deg";

  return (
    <div className="flex items-center gap-4">
      <div
        className="relative h-32 w-32 shrink-0 rounded-full"
        style={{ background: `conic-gradient(${background})` }}
      >
        <div className="absolute inset-4 rounded-full bg-[#1A1A1A] flex items-center justify-center text-center">
          <div>
            <p className="text-[11px] text-[#888888]">Dépenses</p>
            <p className="text-sm font-bold">{formatFcfa(total)}</p>
          </div>
        </div>
      </div>
      <div className="space-y-2 text-xs">
        {CATEGORIES.map((category) => (
          <div key={category} className="flex items-center gap-2 text-[#888888]">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: CATEGORY_META[category].color }} />
            <span>{CATEGORY_META[category].icon}</span>
            <span className="capitalize">{category}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TransactionRow({ tx }) {
  const meta = CATEGORY_META[tx.category] || { icon: "💸", color: "#1D9E75" };
  return (
    <div className="flex items-center justify-between rounded-xl border border-[#2A2A2A] bg-[#121212] p-3">
      <div className="flex items-center gap-3">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-full text-sm"
          style={{ background: `${meta.color}22`, color: meta.color }}
        >
          {meta.icon}
        </span>
        <div>
          <p className="text-sm font-semibold capitalize text-white">{tx.category}</p>
          <p className="text-xs text-[#888888]">
            {tx.wallet} - {new Date(tx.date).toLocaleDateString("fr-FR")}
          </p>
        </div>
      </div>
      <p className={`text-sm font-bold ${tx.type === "revenu" ? "text-green-400" : "text-red-400"}`}>
        {tx.type === "revenu" ? "+" : "-"}
        {formatFcfa(tx.amount)}
      </p>
    </div>
  );
}

function PremiumCard({ title, children }) {
  return (
    <section className="animate-slide-up rounded-2xl border border-[#2A2A2A] bg-[#1A1A1A] p-4 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
      <h2 className="mb-3 text-sm font-semibold text-[#888888]">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="mb-1 block text-sm text-[#888888]">{label}</label>
      {children}
    </div>
  );
}

function TabButton({ active, onClick, label, icon }) {
  return (
    <button className="flex flex-1 flex-col items-center py-2 text-xs" onClick={onClick} type="button">
      <span className={`text-sm ${active ? "text-[#1D9E75]" : "text-[#888888]"}`}>{icon}</span>
      <span className={`mt-1 font-semibold ${active ? "text-[#1D9E75]" : "text-[#888888]"}`}>{label}</span>
    </button>
  );
}

export default App;
