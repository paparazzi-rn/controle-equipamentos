"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { authorizedEmail, documentsBucket, supabase } from "./supabase";

type Store = { id: number; name: string; state: string; city: string; address?: string };
type Attachment = { id: string; name: string; type: string; size: number; kind: "Nota fiscal" | "Garantia estendida"; path?: string };
type Equipment = {
  id: number;
  name: string;
  type: string;
  storeId: number;
  serial: string;
  purchaseDate: string;
  value: number;
  warrantyStart: string;
  warrantyEnd: string;
  extendedWarrantyEnd?: string;
  warrantyClosed?: boolean;
  notes: string;
  active: boolean;
  attachments: Attachment[];
};

const storesSeed: Store[] = [
  { id: 1, name: "Loja Aram", state: "RN", city: "Natal" },
  { id: 2, name: "Loja Enotel", state: "PE", city: "Porto de Galinhas" },
  { id: 3, name: "Loja Vila do Mar", state: "RN", city: "Natal" },
  { id: 4, name: "Loja The Westin", state: "PB", city: "João Pessoa" },
];

const equipmentSeed: Equipment[] = [
  { id: 101, name: "Notebook Dell Inspiron", type: "Notebook", storeId: 1, serial: "DL-8X2K-410", purchaseDate: "2026-01-18", value: 4299, warrantyStart: "2026-01-18", warrantyEnd: "2027-01-18", notes: "Equipamento da administração", active: true, attachments: [{ id: "demo-1", name: "nota-fiscal-dell.pdf", type: "application/pdf", size: 248000, kind: "Nota fiscal" }] },
  { id: 102, name: "Monitor LG 24\"", type: "Monitor", storeId: 2, serial: "LG24-99281", purchaseDate: "2025-11-03", value: 899, warrantyStart: "2025-11-03", warrantyEnd: "2026-11-03", notes: "", active: true, attachments: [] },
  { id: 103, name: "Roteador TP-Link AX", type: "Roteador", storeId: 3, serial: "TPL-AX-7740", purchaseDate: "2025-07-10", value: 629, warrantyStart: "2025-07-10", warrantyEnd: "2026-07-10", notes: "Substituído por modelo mais novo", active: false, attachments: [] },
  { id: 104, name: "Impressora Epson L3250", type: "Impressora", storeId: 4, serial: "EPS-L32-4401", purchaseDate: "2026-03-02", value: 1190, warrantyStart: "2026-03-02", warrantyEnd: "2027-03-02", notes: "Possui garantia estendida", active: true, attachments: [] },
];

const initialTypes = ["Computador", "Monitor", "Notebook", "TV", "Cabo", "Mouse", "Teclado", "Impressora", "Roteador"];
const navItems = ["Visão geral", "Lojas", "Equipamentos", "Garantias", "Inativos"];

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
}

function formatDate(date: string) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

function warrantyState(end: string, closed = false, start = "") {
  if (closed) return { label: "Encerrada", className: "danger" };
  if (!end && start) return { label: "Em garantia", className: "success" };
  if (!end) return { label: "Não iniciada", className: "neutral" };
  const days = Math.ceil((new Date(`${end}T23:59:59`).getTime() - Date.now()) / 86400000);
  if (days < 0) return { label: "Vencida", className: "danger" };
  if (days <= 90) return { label: `Vence em ${days} dias`, className: "warning" };
  return { label: "Em garantia", className: "success" };
}

function effectiveWarrantyEnd(item: Equipment) {
  if (item.extendedWarrantyEnd && (!item.warrantyEnd || item.extendedWarrantyEnd > item.warrantyEnd)) return item.extendedWarrantyEnd;
  return item.warrantyEnd;
}

function equipmentWarrantyState(item: Equipment) {
  return warrantyState(effectiveWarrantyEnd(item), item.warrantyClosed, item.warrantyStart);
}

function bytes(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function openLegacyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("controle-equipamentos-files", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readLegacyBlob(id: string) {
  const db = await openLegacyDb();
  const blob = await new Promise<Blob | undefined>((resolve, reject) => {
    const req = db.transaction("files", "readonly").objectStore("files").get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return blob;
}

async function viewDocument(file: Attachment) {
  if (!supabase || !file.path) {
    alert("Arquivo não encontrado no armazenamento seguro.");
    return;
  }
  const { data, error } = await supabase.storage.from(documentsBucket).download(file.path);
  if (error || !data) {
    alert("Não foi possível abrir este documento.");
    return;
  }
  const blob = data;
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function safeFileName(name: string) {
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return normalized.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(-160);
}

export default function Home() {
  const [authReady, setAuthReady] = useState(false);
  const [logged, setLogged] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [section, setSection] = useState("Visão geral");
  const [mobileNav, setMobileNav] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [equipments, setEquipments] = useState<Equipment[]>([]);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("Todos");
  const [storeFilter, setStoreFilter] = useState("Todas");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [modal, setModal] = useState<"equipment" | "store" | "type" | "details" | null>(null);
  const [selected, setSelected] = useState<Equipment | null>(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    let mounted = true;
    if (!supabase) {
      queueMicrotask(() => { if (mounted) setAuthReady(true); });
      return () => { mounted = false; };
    }
    void supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      const validSession = data.session?.user.email?.toLowerCase() === authorizedEmail;
      setLogged(validSession);
      setAuthReady(true);
      if (validSession) void loadCloudData();
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setLogged(session?.user.email?.toLowerCase() === authorizedEmail);
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  // Authentication bootstrap intentionally runs once; data refreshes are explicit after mutations.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 2800);
    return () => clearTimeout(timer);
  }, [toast]);

  const active = equipments.filter((item) => item.active);
  const states = [...new Set(stores.map((store) => store.state))];
  const filtered = useMemo(() => equipments.filter((item) => {
    const store = stores.find((s) => s.id === item.storeId);
    const matchesQuery = `${item.name} ${item.serial} ${item.type} ${store?.name}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (stateFilter === "Todos" || store?.state === stateFilter) && (storeFilter === "Todas" || `${item.storeId}` === storeFilter) && (!periodStart || item.purchaseDate >= periodStart) && (!periodEnd || item.purchaseDate <= periodEnd);
  }), [equipments, stores, query, stateFilter, storeFilter, periodStart, periodEnd]);

  async function migrateLegacyData() {
    if (!supabase || typeof window === "undefined") return;
    const { data: userResult, error: userError } = await supabase.auth.getUser();
    const user = userResult.user;
    if (userError || !user || user.email?.toLowerCase() !== authorizedEmail) throw new Error("Sessão inválida.");

    const readLegacy = <T,>(key: string, fallback: T): T => {
      try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) as T : fallback;
      } catch {
        return fallback;
      }
    };
    const legacyStores = readLegacy<Store[]>("ce_stores", storesSeed);
    const legacyEquipments = readLegacy<Equipment[]>("ce_equipments", equipmentSeed);
    const legacyTypes = readLegacy<string[]>("ce_types", initialTypes);
    const allTypeNames = [...new Set([...initialTypes, ...legacyTypes, ...legacyEquipments.map((item) => item.type)])];

    const { data: insertedTypes, error: typeError } = await supabase
      .from("equipment_types")
      .insert(allTypeNames.map((name) => ({ owner_id: user.id, name })))
      .select("id, name");
    if (typeError) throw typeError;
    const typeIds = new Map((insertedTypes || []).map((item) => [item.name, item.id]));

    const { data: insertedStores, error: storeError } = await supabase
      .from("stores")
      .insert(legacyStores.map((store) => ({
        owner_id: user.id,
        name: store.name,
        state: store.state.toUpperCase(),
        city: store.city || "",
        address: store.address || "",
      })))
      .select("id, name");
    if (storeError) throw storeError;
    const storeIds = new Map(legacyStores.map((store, index) => [store.id, insertedStores?.[index]?.id]));

    for (const item of legacyEquipments) {
      const equipmentTypeId = typeIds.get(item.type);
      const storeId = storeIds.get(item.storeId);
      if (!equipmentTypeId || !storeId) continue;
      const { data: created, error: equipmentError } = await supabase.from("equipments").insert({
        owner_id: user.id,
        name: item.name,
        equipment_type_id: equipmentTypeId,
        store_id: storeId,
        serial_number: item.serial,
        purchase_date: item.purchaseDate,
        purchase_value: item.value || 0,
        warranty_start: item.warrantyStart || null,
        warranty_end: item.warrantyEnd || null,
        extended_warranty_end: item.extendedWarrantyEnd || null,
        warranty_closed: Boolean(item.warrantyClosed),
        notes: item.notes || "",
        active: item.active,
      }).select("id").single();
      if (equipmentError || !created) throw equipmentError || new Error("Falha ao migrar equipamento.");

      for (const file of item.attachments || []) {
        let blob: Blob | undefined;
        try { blob = await readLegacyBlob(file.id); } catch { blob = undefined; }
        if (!blob || !["application/pdf", "image/jpeg", "image/png"].includes(file.type)) continue;
        const path = `${user.id}/${created.id}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
        const { error: uploadError } = await supabase.storage.from(documentsBucket).upload(path, blob, { contentType: file.type, upsert: false });
        if (uploadError) continue;
        await supabase.from("attachments").insert({
          owner_id: user.id,
          equipment_id: created.id,
          file_name: file.name,
          mime_type: file.type,
          size_bytes: file.size,
          kind: file.kind,
          storage_path: path,
        });
      }
    }
    localStorage.setItem("ce_cloud_migrated", "yes");
  }

  async function loadCloudData(allowMigration = true) {
    if (!supabase) return;
    setLoadingData(true);
    try {
      const [storeResult, typeResult, equipmentResult] = await Promise.all([
        supabase.from("stores").select("id, name, state, city, address").order("name"),
        supabase.from("equipment_types").select("id, name").order("name"),
        supabase.from("equipments").select("id, name, store_id, serial_number, purchase_date, purchase_value, warranty_start, warranty_end, extended_warranty_end, warranty_closed, notes, active, created_at, equipment_types(name), attachments(id, file_name, mime_type, size_bytes, kind, storage_path)").order("created_at", { ascending: false }),
      ]);
      const firstError = storeResult.error || typeResult.error || equipmentResult.error;
      if (firstError) throw firstError;
      if (allowMigration && !storeResult.data?.length && !equipmentResult.data?.length) {
        await migrateLegacyData();
        await loadCloudData(false);
        return;
      }
      setStores((storeResult.data || []).map((store) => ({
        id: store.id,
        name: store.name,
        state: store.state,
        city: store.city,
        address: store.address,
      })));
      setTypes((typeResult.data || []).map((type) => type.name));
      setEquipments((equipmentResult.data || []).map((item) => {
        const relation = Array.isArray(item.equipment_types) ? item.equipment_types[0] : item.equipment_types;
        return {
          id: item.id,
          name: item.name,
          type: relation?.name || "Sem tipo",
          storeId: item.store_id,
          serial: item.serial_number,
          purchaseDate: item.purchase_date,
          value: Number(item.purchase_value || 0),
          warrantyStart: item.warranty_start || "",
          warrantyEnd: item.warranty_end || "",
          extendedWarrantyEnd: item.extended_warranty_end || "",
          warrantyClosed: item.warranty_closed,
          notes: item.notes || "",
          active: item.active,
          attachments: (item.attachments || []).map((file) => ({
            id: file.id,
            name: file.file_name,
            type: file.mime_type,
            size: Number(file.size_bytes),
            kind: file.kind as Attachment["kind"],
            path: file.storage_path,
          })),
        };
      }));
    } catch (error) {
      console.error(error);
      setToast("Não foi possível carregar os dados do servidor.");
    } finally {
      setLoadingData(false);
    }
  }

  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!supabase) {
      setLoginError("O banco seguro ainda não está configurado.");
      return;
    }
    const data = new FormData(e.currentTarget);
    const email = String(data.get("email")).trim().toLowerCase();
    const password = String(data.get("password"));
    if (email !== authorizedEmail) {
      setLoginError("E-mail ou senha incorretos.");
      return;
    }
    setLoginError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoginError(error.message.toLowerCase().includes("confirm")
        ? "Confirme o e-mail enviado pelo Supabase antes do primeiro acesso."
        : "E-mail ou senha incorretos.");
      return;
    }
    setLogged(true);
    await loadCloudData();
  }

  async function logout() {
    await supabase?.auth.signOut();
    setLogged(false);
    setStores([]);
    setTypes([]);
    setEquipments([]);
  }

  async function addStore(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!supabase) return;
    const data = new FormData(e.currentTarget);
    const { data: created, error } = await supabase.from("stores").insert({
      name: String(data.get("name")).trim(),
      state: String(data.get("state")).trim().toUpperCase(),
      city: String(data.get("city") || "").trim(),
      address: String(data.get("address") || "").trim(),
    }).select("id, name, state, city, address").single();
    if (error || !created) {
      setToast("Não foi possível cadastrar a loja.");
      return;
    }
    setStores((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
    setModal(null);
    setToast("Loja cadastrada com sucesso.");
  }

  async function addType(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!supabase) return;
    const value = `${new FormData(e.currentTarget).get("name")}`.trim();
    if (!value || types.includes(value)) {
      setModal("equipment");
      setToast("Esse tipo já está cadastrado.");
      return;
    }
    const { error } = await supabase.from("equipment_types").insert({ name: value });
    if (error) {
      setToast("Não foi possível cadastrar o tipo.");
      return;
    }
    setTypes((current) => [...current, value].sort());
    setModal("equipment");
    setToast("Tipo de equipamento cadastrado.");
  }

  async function addEquipment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!supabase) return;
    const data = new FormData(e.currentTarget);
    const input = e.currentTarget.elements.namedItem("files") as HTMLInputElement;
    const fileList = Array.from(input.files || []);
    const allowedTypes = ["application/pdf", "image/jpeg", "image/png"];
    if (fileList.some((file) => !allowedTypes.includes(file.type))) {
      setToast("Envie somente arquivos PDF, JPG ou PNG.");
      return;
    }
    const { data: userResult } = await supabase.auth.getUser();
    const user = userResult.user;
    const { data: selectedType, error: typeError } = await supabase.from("equipment_types").select("id").eq("name", String(data.get("type"))).single();
    if (!user || typeError || !selectedType) {
      setToast("Não foi possível validar o cadastro.");
      return;
    }
    const { data: created, error: equipmentError } = await supabase.from("equipments").insert({
      name: String(data.get("name")).trim(),
      equipment_type_id: selectedType.id,
      store_id: Number(data.get("store")),
      serial_number: String(data.get("serial")).trim(),
      purchase_date: String(data.get("purchaseDate")),
      purchase_value: Number(data.get("value") || 0),
      warranty_start: String(data.get("warrantyStart") || "") || null,
      warranty_end: String(data.get("warrantyEnd") || "") || null,
      extended_warranty_end: String(data.get("extendedWarrantyEnd") || "") || null,
      warranty_closed: false,
      notes: String(data.get("notes") || "").trim(),
      active: true,
    }).select("id").single();
    if (equipmentError || !created) {
      setToast(equipmentError?.code === "23505" ? "Já existe um equipamento com esse número de série." : "Não foi possível cadastrar o equipamento.");
      return;
    }
    let uploadFailures = 0;
    for (const file of fileList) {
      const path = `${user.id}/${created.id}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
      const { error: uploadError } = await supabase.storage.from(documentsBucket).upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) {
        uploadFailures += 1;
        continue;
      }
      const { error: attachmentError } = await supabase.from("attachments").insert({
        equipment_id: created.id,
        file_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
        kind: file.name.toLowerCase().includes("garantia") ? "Garantia estendida" : "Nota fiscal",
        storage_path: path,
      });
      if (attachmentError) uploadFailures += 1;
    }
    await loadCloudData(false);
    setModal(null);
    setToast(uploadFailures ? "Equipamento salvo, mas alguns documentos não foram enviados." : "Equipamento cadastrado com sucesso.");
  }

  async function toggleActive(item: Equipment) {
    if (!supabase) return;
    const { error } = await supabase.from("equipments").update({ active: !item.active }).eq("id", item.id);
    if (error) {
      setToast("Não foi possível alterar o equipamento.");
      return;
    }
    setEquipments((current) => current.map((eq) => eq.id === item.id ? { ...eq, active: !eq.active } : eq));
    setSelected(null); setModal(null);
    setToast(item.active ? "Equipamento movido para inativos." : "Equipamento reativado.");
  }

  async function changeWarranty(item: Equipment, action: "start" | "end") {
    if (!supabase) return;
    const today = new Date().toISOString().slice(0, 10);
    const updated = action === "start"
      ? { ...item, warrantyStart: today, warrantyClosed: false }
      : { ...item, warrantyEnd: today, extendedWarrantyEnd: "", warrantyClosed: true };
    const { error } = await supabase.from("equipments").update(action === "start"
      ? { warranty_start: today, warranty_closed: false }
      : { warranty_end: today, extended_warranty_end: null, warranty_closed: true }
    ).eq("id", item.id);
    if (error) {
      setToast("Não foi possível atualizar a garantia.");
      return;
    }
    setEquipments((current) => current.map((eq) => eq.id === item.id ? updated : eq));
    setSelected(updated);
    setToast(action === "start" ? "Garantia iniciada com sucesso." : "Garantia encerrada com sucesso.");
  }

  if (!authReady) return <main className="loading-page"><div><span className="brand-mark">CE</span><p>Carregando ambiente seguro...</p></div></main>;

  if (!logged) return (
    <main className="login-page">
      <section className="login-brand">
        <div className="brand-mark">CE</div>
        <div className="brand-copy"><span>CONTROLE</span><strong>EQUIPAMENTOS</strong></div>
        <div className="login-message">
          <p>Gestão simples e segura</p>
          <h1>Seus equipamentos e documentos em um só lugar.</h1>
          <p className="login-description">Controle garantias, localize notas fiscais e acompanhe todos os ativos da empresa.</p>
        </div>
      </section>
      <section className="login-panel">
        <form className="login-card" onSubmit={login}>
          <div className="mobile-brand"><div className="brand-mark">CE</div><strong>Controle de Equipamentos</strong></div>
          <p className="eyebrow">ACESSO AO SISTEMA</p>
          <h2>Bem-vindo</h2>
          <p className="muted">Entre com suas credenciais para continuar.</p>
          <label>E-mail<input name="email" type="email" placeholder="Digite seu e-mail" autoComplete="username" required /></label>
          <label>Senha<input name="password" type="password" placeholder="Digite sua senha" autoComplete="current-password" required /></label>
          {loginError && <p className="form-error">{loginError}</p>}
          <button className="primary full" type="submit">Entrar no sistema <span>→</span></button>
        </form>
      </section>
    </main>
  );

  if (loadingData) return <main className="loading-page"><div><span className="brand-mark">CE</span><p>Sincronizando dados protegidos...</p></div></main>;

  const contentRows = section === "Inativos" ? filtered.filter((i) => !i.active) : filtered.filter((i) => i.active);

  return (
    <main className="app-shell">
      <aside className={mobileNav ? "sidebar open" : "sidebar"}>
        <div className="sidebar-brand"><div className="brand-mark small">CE</div><div><b>Controle</b><span>Equipamentos</span></div></div>
        <nav>{navItems.map((item) => <button key={item} className={section === item ? "active" : ""} onClick={() => { setSection(item); setMobileNav(false); }}><span className="nav-icon">{item === "Visão geral" ? "⌂" : item === "Lojas" ? "▦" : item === "Equipamentos" ? "▣" : item === "Garantias" ? "◇" : "↘"}</span>{item}{item === "Inativos" && <small>{equipments.filter((e) => !e.active).length}</small>}</button>)}</nav>
        <div className="sidebar-user"><div className="avatar">AD</div><div><b>Administrador</b><span>tipaparazzirn</span></div><button title="Sair" onClick={logout}>↪</button></div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <button className="menu-button" onClick={() => setMobileNav(!mobileNav)}>☰</button>
          <div><p className="breadcrumb">Sistema / {section}</p><h1>{section}</h1></div>
          <div className="top-actions"><button className="secondary" onClick={() => setModal("store")}>+ Nova loja</button><button className="primary" onClick={() => setModal("equipment")}>+ Novo equipamento</button></div>
        </header>

        {section === "Visão geral" && <Dashboard active={active} stores={stores} equipments={equipments} setSection={setSection} setSelected={setSelected} setModal={setModal} />}
        {section === "Lojas" && <StoresView stores={stores} equipments={equipments} onOpen={(id) => { setStoreFilter(`${id}`); setSection("Equipamentos"); }} onNew={() => setModal("store")} />}
        {(section === "Equipamentos" || section === "Inativos") && <EquipmentView section={section} rows={contentRows} stores={stores} states={states} query={query} setQuery={setQuery} stateFilter={stateFilter} setStateFilter={setStateFilter} storeFilter={storeFilter} setStoreFilter={setStoreFilter} periodStart={periodStart} setPeriodStart={setPeriodStart} periodEnd={periodEnd} setPeriodEnd={setPeriodEnd} onOpen={(item) => { setSelected(item); setModal("details"); }} />}
        {section === "Garantias" && <WarrantyView equipments={active} stores={stores} onOpen={(item) => { setSelected(item); setModal("details"); }} />}
      </section>

      {modal && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
        {modal === "equipment" && <EquipmentForm stores={stores} types={types} onSubmit={addEquipment} onClose={() => setModal(null)} onNewType={() => setModal("type")} />}
        {modal === "store" && <StoreForm states={states} onSubmit={addStore} onClose={() => setModal(null)} />}
        {modal === "type" && <TypeForm onSubmit={addType} onClose={() => setModal("equipment")} />}
        {modal === "details" && selected && <Details item={selected} store={stores.find((s) => s.id === selected.storeId)} onClose={() => setModal(null)} onToggle={() => toggleActive(selected)} onWarrantyAction={(action) => changeWarranty(selected, action)} />}
      </div>}
      {toast && <div className="toast">✓ {toast}</div>}
    </main>
  );
}

function Dashboard({ active, stores, equipments, setSection, setSelected, setModal }: { active: Equipment[]; stores: Store[]; equipments: Equipment[]; setSection: (s: string) => void; setSelected: (e: Equipment) => void; setModal: (m: "details") => void }) {
  const expiring = active.filter((e) => ["warning", "danger"].includes(equipmentWarrantyState(e).className));
  const totalValue = active.reduce((sum, item) => sum + item.value, 0);
  return <div className="content">
    <div className="welcome"><div><h2>Olá, Administrador!</h2><p>Acompanhe a situação dos equipamentos e garantias.</p></div><span>{new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date())}</span></div>
    <section className="metrics">
      <Metric icon="▣" tone="blue" label="Equipamentos ativos" value={`${active.length}`} detail={`${equipments.filter((e) => !e.active).length} inativos`} />
      <Metric icon="▦" tone="violet" label="Lojas cadastradas" value={`${stores.length}`} detail={`${new Set(stores.map((s) => s.state)).size} estados`} />
      <Metric icon="◇" tone="amber" label="Garantias em atenção" value={`${expiring.length}`} detail="Vencidas ou até 90 dias" />
      <Metric icon="R$" tone="green" label="Valor dos ativos" value={money(totalValue)} detail="Valor total cadastrado" />
    </section>
    <section className="dashboard-grid">
      <div className="panel"><div className="panel-head"><div><h3>Garantias que exigem atenção</h3><p>Priorize os equipamentos próximos do vencimento.</p></div><button onClick={() => setSection("Garantias")}>Ver todas →</button></div>
        <div className="attention-list">{expiring.slice(0, 4).map((item) => <button key={item.id} onClick={() => { setSelected(item); setModal("details"); }}><span className={`status-dot ${equipmentWarrantyState(item).className}`}></span><div><b>{item.name}</b><small>{stores.find((s) => s.id === item.storeId)?.name} · {item.serial}</small></div><div className="right"><b>{formatDate(effectiveWarrantyEnd(item))}</b><small className={equipmentWarrantyState(item).className}>{equipmentWarrantyState(item).label}</small></div></button>)}</div>
      </div>
      <div className="panel"><div className="panel-head"><div><h3>Equipamentos por loja</h3><p>Distribuição atual dos ativos.</p></div></div>
        <div className="store-bars">{stores.map((store) => { const count = active.filter((e) => e.storeId === store.id).length; const max = Math.max(1, ...stores.map((s) => active.filter((e) => e.storeId === s.id).length)); return <div key={store.id}><div><span>{store.name}</span><b>{count}</b></div><div className="bar"><i style={{ width: `${(count / max) * 100}%` }}></i></div></div>; })}</div>
      </div>
    </section>
    <div className="panel"><div className="panel-head"><div><h3>Cadastros recentes</h3><p>Últimos equipamentos adicionados ao sistema.</p></div><button onClick={() => setSection("Equipamentos")}>Ver equipamentos →</button></div><EquipmentTable rows={active.slice(0, 5)} stores={stores} onOpen={(item) => { setSelected(item); setModal("details"); }} /></div>
  </div>;
}

function Metric({ icon, tone, label, value, detail }: { icon: string; tone: string; label: string; value: string; detail: string }) {
  return <article className="metric"><span className={`metric-icon ${tone}`}>{icon}</span><div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div></article>;
}

function StoresView({ stores, equipments, onOpen, onNew }: { stores: Store[]; equipments: Equipment[]; onOpen: (id: number) => void; onNew: () => void }) {
  return <div className="content"><div className="section-title"><div><h2>Lojas cadastradas</h2><p>Selecione uma loja para visualizar seus equipamentos.</p></div><button className="primary" onClick={onNew}>+ Cadastrar loja</button></div><div className="store-grid">{stores.map((store) => { const items = equipments.filter((e) => e.storeId === store.id && e.active); return <article className="store-card" key={store.id}><div className="store-card-top"><span>▦</span><small>{store.state}</small></div><h3>{store.name}</h3><p>{store.city || "Cidade não informada"} · {store.state}</p><div className="store-stats"><div><b>{items.length}</b><span>Ativos</span></div><div><b>{items.filter((e) => equipmentWarrantyState(e).className === "warning").length}</b><span>Em atenção</span></div></div><button onClick={() => onOpen(store.id)}>Ver equipamentos <span>→</span></button></article>; })}</div></div>;
}

type EquipmentViewProps = {
  section: string; rows: Equipment[]; stores: Store[]; states: string[];
  query: string; setQuery: (value: string) => void;
  stateFilter: string; setStateFilter: (value: string) => void;
  storeFilter: string; setStoreFilter: (value: string) => void;
  periodStart: string; setPeriodStart: (value: string) => void;
  periodEnd: string; setPeriodEnd: (value: string) => void;
  onOpen: (item: Equipment) => void;
};

function EquipmentView({ section, rows, stores, states, query, setQuery, stateFilter, setStateFilter, storeFilter, setStoreFilter, periodStart, setPeriodStart, periodEnd, setPeriodEnd, onOpen }: EquipmentViewProps) {
  return <div className="content"><div className="section-title"><div><h2>{section === "Inativos" ? "Equipamentos inativos" : "Todos os equipamentos"}</h2><p>{section === "Inativos" ? "Itens preservados fora das páginas das lojas." : "Pesquise e consulte os equipamentos cadastrados."}</p></div><span className="result-count">{rows.length} resultado{rows.length !== 1 ? "s" : ""}</span></div>
    <div className="filters"><label className="search"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por nome ou número de série..." /></label><select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}><option>Todos</option>{states.map((s) => <option key={s}>{s}</option>)}</select><select value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)}><option value="Todas">Todas as lojas</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><label className="date-filter"><span>De</span><input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></label><label className="date-filter"><span>Até</span><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></label></div>
    <div className="panel table-panel"><EquipmentTable rows={rows} stores={stores} onOpen={onOpen} empty={section === "Inativos" ? "Nenhum equipamento inativo." : "Nenhum equipamento encontrado."} /></div>
  </div>;
}

function EquipmentTable({ rows, stores, onOpen, empty = "Nenhum item." }: { rows: Equipment[]; stores: Store[]; onOpen: (e: Equipment) => void; empty?: string }) {
  if (!rows.length) return <div className="empty-state"><span>⌕</span><h3>{empty}</h3><p>Altere os filtros ou faça um novo cadastro.</p></div>;
  return <div className="table-wrap"><table><thead><tr><th>Equipamento</th><th>Loja</th><th>Nº de série</th><th>Compra</th><th>Garantia</th><th>Documentos</th><th></th></tr></thead><tbody>{rows.map((item) => { const state = equipmentWarrantyState(item); return <tr key={item.id} onClick={() => onOpen(item)}><td><div className="equipment-cell"><span>▣</span><div><b>{item.name}</b><small>{item.type}</small></div></div></td><td>{stores.find((s) => s.id === item.storeId)?.name}<small className="td-sub">{stores.find((s) => s.id === item.storeId)?.state}</small></td><td className="serial">{item.serial}</td><td>{formatDate(item.purchaseDate)}</td><td><span className={`pill ${state.className}`}>{state.label}</span>{item.extendedWarrantyEnd && <small className="td-sub">Estendida até {formatDate(item.extendedWarrantyEnd)}</small>}</td><td><span className="doc-count">▤ {item.attachments.length}</span></td><td><button className="more" aria-label={`Abrir detalhes de ${item.name}`}>•••</button></td></tr>; })}</tbody></table></div>;
}

function WarrantyView({ equipments, stores, onOpen }: { equipments: Equipment[]; stores: Store[]; onOpen: (e: Equipment) => void }) {
  const [search, setSearch] = useState("");
  const [expiryFilter, setExpiryFilter] = useState("all");
  const [referenceTime] = useState(() => Date.now());
  const searched = equipments.filter((item) => {
    const store = stores.find((s) => s.id === item.storeId);
    return `${item.name} ${item.serial} ${item.type} ${store?.name}`.toLowerCase().includes(search.toLowerCase());
  });
  const validRows = searched.filter((e) => equipmentWarrantyState(e).className === "success").filter((item) => {
    if (expiryFilter === "all") return true;
    const end = effectiveWarrantyEnd(item);
    if (!end) return expiryFilter === "no-date";
    const days = Math.ceil((new Date(`${end}T23:59:59`).getTime() - referenceTime) / 86400000);
    if (expiryFilter === "six-months") return days <= 180;
    if (expiryFilter === "one-year") return days > 180 && days <= 365;
    return expiryFilter === "over-year" ? days > 365 : true;
  }).sort((a, b) => effectiveWarrantyEnd(a).localeCompare(effectiveWarrantyEnd(b)));
  const groups = [
    { title: "Vencidas e encerradas", tone: "danger", rows: searched.filter((e) => equipmentWarrantyState(e).className === "danger") },
    { title: "Vencem nos próximos 90 dias", tone: "warning", rows: searched.filter((e) => equipmentWarrantyState(e).className === "warning") },
    { title: "Garantias vigentes", tone: "success", rows: validRows },
  ];
  return <div className="content"><div className="section-title"><div><h2>Controle de garantias</h2><p>Acompanhe prazos e documentos relacionados.</p></div></div><div className="warranty-search"><label className="search"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar equipamento, loja ou número de série..." /></label></div>{groups.map((group) => <section className="panel warranty-group" key={group.title}><div className="group-title"><span className={`status-dot ${group.tone}`}></span><h3>{group.title}</h3>{group.tone === "success" && <label className="expiry-filter"><span>Vencimento</span><select value={expiryFilter} onChange={(e) => setExpiryFilter(e.target.value)}><option value="all">Todos os vencimentos</option><option value="six-months">Até 6 meses</option><option value="one-year">De 6 a 12 meses</option><option value="over-year">Mais de 1 ano</option><option value="no-date">Sem data definida</option></select></label>}<b>{group.rows.length}</b></div><EquipmentTable rows={group.rows} stores={stores} onOpen={onOpen} empty={`Nenhum equipamento em “${group.title}”.`} /></section>)}</div>;
}

function EquipmentForm({ stores, types, onSubmit, onClose, onNewType }: { stores: Store[]; types: string[]; onSubmit: (e: FormEvent<HTMLFormElement>) => void; onClose: () => void; onNewType: () => void }) {
  return <form className="modal large" onSubmit={onSubmit}><ModalHead title="Novo equipamento" subtitle="Cadastre os dados, a garantia e os documentos." onClose={onClose} /><div className="form-grid"><label className="span-2">Nome do equipamento<input name="name" placeholder="Ex.: Notebook Dell Inspiron" required /></label><label>Tipo<select name="type" required>{types.map((t) => <option key={t}>{t}</option>)}</select><button type="button" className="inline-link" onClick={onNewType}>+ Criar novo tipo</button></label><label>Loja<select name="store" required>{stores.map((s) => <option value={s.id} key={s.id}>{s.name} — {s.state}</option>)}</select><small className="field-help">A loja não poderá ser alterada após salvar.</small></label><label>Número de série<input name="serial" placeholder="Digite o número de série" required /></label><label>Data da compra<input name="purchaseDate" type="date" required /></label><label>Valor (opcional)<input name="value" type="number" min="0" step="0.01" placeholder="0,00" /></label><label>Início da garantia<input name="warrantyStart" type="date" /></label><label>Término da garantia<input name="warrantyEnd" type="date" /></label><label>Garantia estendida até (opcional)<input name="extendedWarrantyEnd" type="date" /><small className="field-help">Esta data passa a ser o vencimento efetivo da garantia.</small></label><label className="span-2">Notas fiscais e documentos<input className="file-input" name="files" type="file" accept=".pdf,.jpg,.jpeg,.png" multiple /><small className="field-help">PDF, JPG ou PNG. Você pode selecionar a nota e a garantia estendida.</small></label><label className="span-2">Observações<textarea name="notes" placeholder="Informações adicionais sobre o equipamento..." /></label></div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary">Salvar equipamento</button></div></form>;
}

function StoreForm({ states, onSubmit, onClose }: { states: string[]; onSubmit: (e: FormEvent<HTMLFormElement>) => void; onClose: () => void }) {
  return <form className="modal" onSubmit={onSubmit}><ModalHead title="Cadastrar loja" subtitle="Adicione uma nova unidade ao sistema." onClose={onClose} /><div className="form-grid"><label className="span-2">Nome da loja<input name="name" placeholder="Ex.: Loja Aram" required /></label><label>Estado (sigla)<input name="state" maxLength={2} pattern="[A-Za-z]{2}" placeholder="RN" list="states" required /><datalist id="states">{states.map((s) => <option key={s}>{s}</option>)}</datalist></label><label>Cidade (opcional)<input name="city" placeholder="Natal" /></label><label className="span-2">Endereço (opcional)<input name="address" placeholder="Rua, número e bairro" /></label></div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary">Cadastrar loja</button></div></form>;
}

function TypeForm({ onSubmit, onClose }: { onSubmit: (e: FormEvent<HTMLFormElement>) => void; onClose: () => void }) {
  return <form className="modal compact" onSubmit={onSubmit}><ModalHead title="Novo tipo" subtitle="Crie uma nova categoria de equipamento." onClose={onClose} /><label>Nome do tipo<input name="name" placeholder="Ex.: Câmera fotográfica" autoFocus required /></label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Voltar</button><button className="primary">Salvar tipo</button></div></form>;
}

function ModalHead({ title, subtitle, onClose }: { title: string; subtitle: string; onClose: () => void }) { return <div className="modal-head"><div><h2>{title}</h2><p>{subtitle}</p></div><button type="button" onClick={onClose}>×</button></div>; }

function Details({ item, store, onClose, onToggle, onWarrantyAction }: { item: Equipment; store?: Store; onClose: () => void; onToggle: () => void; onWarrantyAction: (action: "start" | "end") => void }) {
  const state = equipmentWarrantyState(item);
  return <section className="modal large details"><ModalHead title={item.name} subtitle={`${item.type} · ${item.serial}`} onClose={onClose} /><div className="details-top"><span className={`pill ${item.active ? "success" : "neutral"}`}>{item.active ? "Equipamento ativo" : "Equipamento inativo"}</span><span className={`pill ${state.className}`}>{state.label}</span>{item.extendedWarrantyEnd && <span className="pill extended">Garantia estendida</span>}</div><div className="detail-grid"><div><span>Loja</span><b>{store?.name}</b><small>{store?.city} · {store?.state}</small></div><div><span>Número de série</span><b className="serial">{item.serial}</b></div><div><span>Data da compra</span><b>{formatDate(item.purchaseDate)}</b></div><div><span>Valor</span><b>{money(item.value)}</b></div><div><span>Início da garantia</span><b>{formatDate(item.warrantyStart)}</b></div><div><span>Término da garantia</span><b>{formatDate(item.warrantyEnd)}</b>{item.extendedWarrantyEnd && <small>Estendida até {formatDate(item.extendedWarrantyEnd)}</small>}</div></div><div className="documents"><h3>Documentos anexados</h3>{item.attachments.length ? item.attachments.map((file) => <div className="document" key={file.id}><span>▤</span><div><b>{file.name}</b><small>{file.kind} · {bytes(file.size)}</small></div><button onClick={() => viewDocument(file)}>Abrir</button></div>) : <p className="muted">Nenhum documento anexado.</p>}</div>{item.notes && <div className="notes"><span>Observações</span><p>{item.notes}</p></div>}<div className="modal-actions detail-actions"><button className={item.active ? "danger-button" : "secondary"} onClick={onToggle}>{item.active ? "Mover para inativos" : "Reativar equipamento"}</button><div><button className="warranty-button start" onClick={() => onWarrantyAction("start")}>Iniciar garantia</button><button className="warranty-button end" onClick={() => onWarrantyAction("end")}>Encerrar garantia</button><button className="primary" onClick={onClose}>Fechar</button></div></div></section>;
}
