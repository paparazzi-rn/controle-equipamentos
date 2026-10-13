"use client";

/* Blob URLs are local authenticated previews and cannot use Next's image optimizer. */
/* eslint-disable @next/next/no-img-element */

import { FormEvent, useEffect, useMemo, useState } from "react";
import { authorizedEmail, documentsBucket, supabase } from "./supabase";

type Store = { id: number; name: string; state: string; city: string; address?: string };
type EquipmentType = { id: number; name: string };
type Attachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: "Nota fiscal" | "Garantia estendida";
  path?: string;
  referenceCode?: string;
};
type Equipment = {
  id: number;
  name: string;
  typeId: number;
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
type AuditLog = {
  id: number;
  action: "INSERT" | "UPDATE" | "DELETE";
  entityType: string;
  entityId: string;
  entityLabel: string;
  actorEmail: string;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  createdAt: string;
};
type ModalName = "equipment" | "store" | "types" | "details" | null;

const navItems = ["Visão geral", "Lojas", "Equipamentos", "Garantias", "Inativos", "Auditoria"];
const allowedFileTypes = ["application/pdf", "image/jpeg", "image/png"];

function addOneYear(date: string) {
  if (!date) return "";
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year + 1, month - 1, day));
  return next.toISOString().slice(0, 10);
}

function normalizeReference(value: string) {
  const cleaned = value.trim().toUpperCase().replace(/^#+/, "").replace(/[^A-Z0-9_-]/g, "").slice(0, 40);
  return cleaned ? `#${cleaned}` : "";
}

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
  const [types, setTypes] = useState<EquipmentType[]>([]);
  const [equipments, setEquipments] = useState<Equipment[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("Todos");
  const [storeFilter, setStoreFilter] = useState("Todas");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [modal, setModal] = useState<ModalName>(null);
  const [selected, setSelected] = useState<Equipment | null>(null);
  const [editingEquipment, setEditingEquipment] = useState<Equipment | null>(null);
  const [editingStore, setEditingStore] = useState<Store | null>(null);
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

  function readLegacyArray<T>(key: string): T[] {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }

  function hasRealLegacyData() {
    if (typeof window === "undefined" || localStorage.getItem("ce_cloud_migrated") === "yes") return false;
    return ["ce_stores", "ce_equipments", "ce_types"].some((key) => {
      const value = localStorage.getItem(key);
      if (!value) return false;
      try { return Array.isArray(JSON.parse(value)) && JSON.parse(value).length > 0; } catch { return false; }
    });
  }

  async function migrateLegacyData() {
    if (!supabase || !hasRealLegacyData()) return false;
    const { data: userResult, error: userError } = await supabase.auth.getUser();
    const user = userResult.user;
    if (userError || !user || user.email?.toLowerCase() !== authorizedEmail) throw new Error("Sessão inválida.");

    const legacyStores = readLegacyArray<Store>("ce_stores");
    const legacyEquipments = readLegacyArray<Equipment>("ce_equipments");
    const legacyTypes = readLegacyArray<string>("ce_types");
    const allTypeNames = [...new Set([...legacyTypes, ...legacyEquipments.map((item) => item.type)].map((name) => `${name}`.trim()).filter(Boolean))];

    if (allTypeNames.length) {
      const { error } = await supabase.from("equipment_types").upsert(
        allTypeNames.map((name) => ({ owner_id: user.id, name })),
        { onConflict: "owner_id,name", ignoreDuplicates: true },
      );
      if (error) throw error;
      localStorage.setItem("ce_cloud_migration_stage", "types");
    }
    const { data: cloudTypes, error: cloudTypesError } = await supabase.from("equipment_types").select("id, name");
    if (cloudTypesError) throw cloudTypesError;
    const typeIds = new Map((cloudTypes || []).map((item) => [item.name, item.id]));

    const { data: currentStores, error: currentStoresError } = await supabase.from("stores").select("id, name, state, city");
    if (currentStoresError) throw currentStoresError;
    const storeKey = (store: Pick<Store, "name" | "state" | "city">) => `${store.name.trim().toLowerCase()}|${store.state.toUpperCase()}|${(store.city || "").trim().toLowerCase()}`;
    const knownStoreKeys = new Set((currentStores || []).map(storeKey));
    const missingStores = legacyStores.filter((store) => !knownStoreKeys.has(storeKey(store)));
    if (missingStores.length) {
      const { error } = await supabase.from("stores").insert(missingStores.map((store) => ({
        owner_id: user.id,
        name: store.name.trim(),
        state: store.state.toUpperCase(),
        city: store.city || "",
        address: store.address || "",
      })));
      if (error) throw error;
    }
    localStorage.setItem("ce_cloud_migration_stage", "stores");
    const { data: cloudStores, error: cloudStoresError } = await supabase.from("stores").select("id, name, state, city");
    if (cloudStoresError) throw cloudStoresError;
    const cloudStoreIds = new Map((cloudStores || []).map((store) => [storeKey(store), store.id]));
    const legacyStoreIds = new Map(legacyStores.map((store) => [store.id, cloudStoreIds.get(storeKey(store))]));

    const { data: existingEquipments, error: equipmentLookupError } = await supabase.from("equipments").select("id, serial_number");
    if (equipmentLookupError) throw equipmentLookupError;
    const equipmentBySerial = new Map((existingEquipments || []).map((item) => [item.serial_number.trim().toLowerCase(), item.id]));
    for (const item of legacyEquipments) {
      const equipmentTypeId = typeIds.get(item.type);
      const storeId = legacyStoreIds.get(item.storeId);
      if (!equipmentTypeId || !storeId || !item.serial?.trim()) continue;
      const serialKey = item.serial.trim().toLowerCase();
      let equipmentId = equipmentBySerial.get(serialKey);
      if (!equipmentId) {
        const { data: created, error } = await supabase.from("equipments").insert({
          owner_id: user.id,
          name: item.name,
          equipment_type_id: equipmentTypeId,
          store_id: storeId,
          serial_number: item.serial.trim(),
          purchase_date: item.purchaseDate,
          purchase_value: item.value || 0,
          warranty_start: item.warrantyStart || null,
          warranty_end: item.warrantyEnd || null,
          extended_warranty_end: item.extendedWarrantyEnd || null,
          warranty_closed: Boolean(item.warrantyClosed),
          notes: item.notes || "",
          active: item.active,
        }).select("id").single();
        if (error || !created) throw error || new Error("Falha ao migrar equipamento.");
        equipmentId = created.id;
        equipmentBySerial.set(serialKey, equipmentId);
      }
      const { data: linkedFiles } = await supabase.from("attachments").select("file_name, size_bytes").eq("equipment_id", equipmentId);
      for (const file of item.attachments || []) {
        if ((linkedFiles || []).some((linked) => linked.file_name === file.name && Number(linked.size_bytes) === file.size)) continue;
        let blob: Blob | undefined;
        try { blob = await readLegacyBlob(file.id); } catch { blob = undefined; }
        if (!blob || !allowedFileTypes.includes(file.type)) continue;
        const path = `${user.id}/${equipmentId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
        const { error: uploadError } = await supabase.storage.from(documentsBucket).upload(path, blob, { contentType: file.type, upsert: false });
        if (uploadError) continue;
        await supabase.from("attachments").insert({ owner_id: user.id, equipment_id: equipmentId, file_name: file.name, mime_type: file.type, size_bytes: file.size, kind: file.kind, storage_path: path });
      }
    }
    localStorage.setItem("ce_cloud_migration_stage", "done");
    localStorage.setItem("ce_cloud_migrated", "yes");
    return true;
  }

  async function loadCloudData(allowMigration = true) {
    if (!supabase) return;
    setLoadingData(true);
    try {
      const [storeResult, typeResult, equipmentResult, auditResult] = await Promise.all([
        supabase.from("stores").select("id, name, state, city, address").order("name"),
        supabase.from("equipment_types").select("id, name").order("name"),
        supabase.from("equipments").select("id, name, equipment_type_id, store_id, serial_number, purchase_date, purchase_value, warranty_start, warranty_end, extended_warranty_end, warranty_closed, notes, active, created_at, equipment_types(name), attachments(id, file_name, mime_type, size_bytes, kind, storage_path, reference_code)").order("created_at", { ascending: false }),
        supabase.from("audit_logs").select("id, action, entity_type, entity_id, entity_label, actor_email, old_values, new_values, created_at").order("created_at", { ascending: false }).limit(1000),
      ]);
      const firstError = storeResult.error || typeResult.error || equipmentResult.error || auditResult.error;
      if (firstError) throw firstError;
      if (allowMigration && hasRealLegacyData() && await migrateLegacyData()) {
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
      setTypes((typeResult.data || []).map((type) => ({ id: type.id, name: type.name })));
      setEquipments((equipmentResult.data || []).map((item) => {
        const relation = Array.isArray(item.equipment_types) ? item.equipment_types[0] : item.equipment_types;
        return {
          id: item.id,
          name: item.name,
          typeId: item.equipment_type_id,
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
            referenceCode: file.reference_code || "",
          })),
        };
      }));
      setAuditLogs((auditResult.data || []).map((entry) => ({
        id: entry.id,
        action: entry.action as AuditLog["action"],
        entityType: entry.entity_type,
        entityId: entry.entity_id,
        entityLabel: entry.entity_label || "",
        actorEmail: entry.actor_email || "sistema",
        oldValues: entry.old_values,
        newValues: entry.new_values,
        createdAt: entry.created_at,
      })));
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
    setAuditLogs([]);
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

  function requestEditStore(store: Store) {
    if (!window.confirm(`Autoriza a edição da loja “${store.name}”? A alteração ficará registrada na auditoria.`)) return;
    setEditingStore(store);
    setModal("store");
  }

  async function updateStore(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!supabase || !editingStore) return;
    const data = new FormData(e.currentTarget);
    const changes = {
      name: String(data.get("name")).trim(),
      state: String(data.get("state")).trim().toUpperCase(),
      city: String(data.get("city") || "").trim(),
      address: String(data.get("address") || "").trim(),
    };
    const { data: updated, error } = await supabase.from("stores").update(changes).eq("id", editingStore.id).select("id, name, state, city, address").single();
    if (error || !updated) {
      setToast("Não foi possível editar a loja.");
      return;
    }
    setStores((current) => current.map((store) => store.id === updated.id ? updated : store).sort((a, b) => a.name.localeCompare(b.name)));
    setEditingStore(null);
    setModal(null);
    await loadCloudData(false);
    setToast("Loja atualizada e registrada na auditoria.");
  }

  async function deleteStore(store: Store) {
    if (!supabase) return;
    const linked = equipments.filter((item) => item.storeId === store.id).length;
    if (linked) {
      setToast(`A loja possui ${linked} equipamento(s). Migre os equipamentos antes de excluir.`);
      return;
    }
    if (!window.confirm(`Autoriza excluir a loja “${store.name}”? Esta ação não pode ser desfeita e ficará registrada na auditoria.`)) return;
    const { error } = await supabase.from("stores").delete().eq("id", store.id);
    if (error) {
      setToast("Não foi possível excluir a loja.");
      return;
    }
    setStores((current) => current.filter((item) => item.id !== store.id));
    await loadCloudData(false);
    setToast("Loja excluída e registrada na auditoria.");
  }

  async function addType(value: string) {
    if (!supabase) return;
    const normalized = value.trim();
    if (!normalized || types.some((type) => type.name.toLowerCase() === normalized.toLowerCase())) {
      setToast("Esse tipo já está cadastrado.");
      return;
    }
    const { data: created, error } = await supabase.from("equipment_types").insert({ name: normalized }).select("id, name").single();
    if (error || !created) {
      setToast("Não foi possível cadastrar o tipo.");
      return;
    }
    setTypes((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
    await loadCloudData(false);
    setToast("Tipo de equipamento cadastrado.");
  }

  async function editType(type: EquipmentType, value: string) {
    if (!supabase) return;
    const normalized = value.trim();
    if (!normalized) return;
    if (!window.confirm(`Autoriza alterar o tipo “${type.name}” para “${normalized}”? Os equipamentos vinculados serão atualizados.`)) return;
    const { error } = await supabase.from("equipment_types").update({ name: normalized }).eq("id", type.id);
    if (error) {
      setToast(error.code === "23505" ? "Já existe um tipo com esse nome." : "Não foi possível editar o tipo.");
      return;
    }
    await loadCloudData(false);
    setToast("Tipo atualizado e registrado na auditoria.");
  }

  async function deleteType(type: EquipmentType) {
    if (!supabase) return;
    const linked = equipments.filter((item) => item.typeId === type.id).length;
    if (linked) {
      setToast(`Este tipo está vinculado a ${linked} equipamento(s) e não pode ser excluído.`);
      return;
    }
    if (!window.confirm(`Autoriza excluir o tipo “${type.name}”? A ação ficará registrada na auditoria.`)) return;
    const { error } = await supabase.from("equipment_types").delete().eq("id", type.id);
    if (error) {
      setToast("Não foi possível excluir o tipo.");
      return;
    }
    await loadCloudData(false);
    setToast("Tipo excluído e registrado na auditoria.");
  }

  async function attachDocuments(equipmentId: number, files: File[], referenceCode: string, userId: string) {
    let failures = 0;
    let reused = 0;
    if (referenceCode) {
      const { data: currentFiles } = await supabase!.from("attachments").select("storage_path").eq("equipment_id", equipmentId);
      const currentPaths = new Set((currentFiles || []).map((file) => file.storage_path));
      const { data: sharedFiles, error: sharedError } = await supabase!.from("attachments")
        .select("file_name, mime_type, size_bytes, kind, storage_path")
        .eq("reference_code", referenceCode)
        .neq("equipment_id", equipmentId);
      if (sharedError) failures += 1;
      const uniqueShared = [...new Map((sharedFiles || []).map((file) => [file.storage_path, file])).values()]
        .filter((file) => !currentPaths.has(file.storage_path));
      if (uniqueShared.length) {
        const { error } = await supabase!.from("attachments").insert(uniqueShared.map((file) => ({
          owner_id: userId,
          equipment_id: equipmentId,
          file_name: file.file_name,
          mime_type: file.mime_type,
          size_bytes: file.size_bytes,
          kind: file.kind,
          storage_path: file.storage_path,
          reference_code: referenceCode,
        })));
        if (error) failures += 1;
        else reused += uniqueShared.length;
      }
    }
    for (const file of files) {
      const path = `${userId}/${equipmentId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
      const { error: uploadError } = await supabase!.storage.from(documentsBucket).upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) {
        failures += 1;
        continue;
      }
      const { error } = await supabase!.from("attachments").insert({
        owner_id: userId,
        equipment_id: equipmentId,
        file_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
        kind: file.name.toLowerCase().includes("garantia") ? "Garantia estendida" : "Nota fiscal",
        storage_path: path,
        reference_code: referenceCode || null,
      });
      if (error) failures += 1;
    }
    return { failures, reused };
  }

  async function saveEquipment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!supabase) return;
    const data = new FormData(e.currentTarget);
    const input = e.currentTarget.elements.namedItem("files") as HTMLInputElement;
    const fileList = Array.from(input.files || []);
    if (fileList.some((file) => !allowedFileTypes.includes(file.type))) {
      setToast("Envie somente arquivos PDF, JPG ou PNG.");
      return;
    }
    const { data: userResult } = await supabase.auth.getUser();
    const user = userResult.user;
    const equipmentTypeId = Number(data.get("type"));
    const storeId = Number(data.get("store"));
    if (!user || !types.some((type) => type.id === equipmentTypeId) || !stores.some((store) => store.id === storeId)) {
      setToast("Não foi possível validar o cadastro.");
      return;
    }
    if (editingEquipment && storeId !== editingEquipment.storeId) {
      const from = stores.find((store) => store.id === editingEquipment.storeId)?.name;
      const to = stores.find((store) => store.id === storeId)?.name;
      if (!window.confirm(`Confirmar migração de loja?\n\nO equipamento sairá de “${from}” e passará para “${to}”. A alteração ficará registrada na auditoria.`)) return;
    }
    const wasEditing = Boolean(editingEquipment);
    const payload = {
      name: String(data.get("name")).trim(),
      equipment_type_id: equipmentTypeId,
      store_id: storeId,
      serial_number: String(data.get("serial")).trim(),
      purchase_date: String(data.get("purchaseDate")),
      purchase_value: Number(data.get("value") || 0),
      warranty_start: String(data.get("warrantyStart") || "") || null,
      warranty_end: String(data.get("warrantyEnd") || "") || null,
      extended_warranty_end: String(data.get("extendedWarrantyEnd") || "") || null,
      warranty_closed: editingEquipment?.warrantyClosed || false,
      notes: String(data.get("notes") || "").trim(),
      ...(editingEquipment ? {} : { active: true }),
    };
    const saveResult = editingEquipment
      ? await supabase.from("equipments").update(payload).eq("id", editingEquipment.id).select("id").single()
      : await supabase.from("equipments").insert(payload).select("id").single();
    const savedId = saveResult.data?.id;
    if (saveResult.error || !savedId) {
      const equipmentError = saveResult.error;
      setToast(equipmentError?.code === "23505" ? "Já existe um equipamento com esse número de série." : "Não foi possível cadastrar o equipamento.");
      return;
    }
    const referenceCode = normalizeReference(String(data.get("referenceCode") || ""));
    if (editingEquipment) {
      await supabase.from("attachments").update({ reference_code: referenceCode || null }).eq("equipment_id", savedId).eq("kind", "Nota fiscal");
    }
    const { failures, reused } = await attachDocuments(savedId, fileList, referenceCode, user.id);
    await loadCloudData(false);
    setEditingEquipment(null);
    setModal(null);
    if (failures) setToast("Equipamento salvo, mas alguns documentos não puderam ser vinculados.");
    else if (reused) setToast(`Equipamento salvo e ${reused} documento(s) compartilhado(s) pelo código ${referenceCode}.`);
    else setToast(wasEditing ? "Equipamento atualizado e registrado na auditoria." : "Equipamento cadastrado com sucesso.");
  }

  function requestEditEquipment(item: Equipment) {
    if (!window.confirm(`Autoriza editar todas as informações de “${item.name}”? As alterações ficarão registradas na auditoria.`)) return;
    setEditingEquipment(item);
    setModal("equipment");
  }

  async function toggleActive(item: Equipment) {
    if (!supabase) return;
    const message = item.active
      ? `Confirmar envio de “${item.name}” para inativos? O histórico e os documentos serão preservados.`
      : `Confirmar reativação de “${item.name}”?`;
    if (!window.confirm(message)) return;
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
    if (!window.confirm(action === "start" ? `Iniciar a garantia de “${item.name}” hoje?` : `Encerrar a garantia de “${item.name}” hoje?`)) return;
    const today = new Date().toISOString().slice(0, 10);
    const automaticEnd = addOneYear(today);
    const updated = action === "start"
      ? { ...item, warrantyStart: today, warrantyEnd: automaticEnd, warrantyClosed: false }
      : { ...item, warrantyEnd: today, extendedWarrantyEnd: "", warrantyClosed: true };
    const { error } = await supabase.from("equipments").update(action === "start"
      ? { warranty_start: today, warranty_end: automaticEnd, warranty_closed: false }
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
        <nav>{navItems.map((item) => <button key={item} className={section === item ? "active" : ""} onClick={() => { setSection(item); setMobileNav(false); }}><span className="nav-icon">{item === "Visão geral" ? "⌂" : item === "Lojas" ? "▦" : item === "Equipamentos" ? "▣" : item === "Garantias" ? "◇" : item === "Auditoria" ? "☷" : "↘"}</span>{item}{item === "Inativos" && <small>{equipments.filter((e) => !e.active).length}</small>}</button>)}</nav>
        <div className="sidebar-user"><div className="avatar">AD</div><div><b>Administrador</b><span>tipaparazzirn</span></div><button title="Sair" onClick={logout}>↪</button></div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <button className="menu-button" onClick={() => setMobileNav(!mobileNav)}>☰</button>
          <div><p className="breadcrumb">Sistema / {section}</p><h1>{section}</h1></div>
          <div className="top-actions"><button className="secondary" onClick={() => { setEditingStore(null); setModal("store"); }}>+ Nova loja</button><button className="primary" onClick={() => { setEditingEquipment(null); setModal("equipment"); }}>+ Novo equipamento</button></div>
        </header>

        {section === "Visão geral" && <Dashboard active={active} stores={stores} equipments={equipments} setSection={setSection} setSelected={setSelected} setModal={setModal} />}
        {section === "Lojas" && <StoresView stores={stores} equipments={equipments} onOpen={(id) => { setStoreFilter(`${id}`); setSection("Equipamentos"); }} onNew={() => { setEditingStore(null); setModal("store"); }} onEdit={requestEditStore} onDelete={deleteStore} />}
        {(section === "Equipamentos" || section === "Inativos") && <EquipmentView section={section} rows={contentRows} stores={stores} states={states} query={query} setQuery={setQuery} stateFilter={stateFilter} setStateFilter={setStateFilter} storeFilter={storeFilter} setStoreFilter={setStoreFilter} periodStart={periodStart} setPeriodStart={setPeriodStart} periodEnd={periodEnd} setPeriodEnd={setPeriodEnd} onOpen={(item) => { setSelected(item); setModal("details"); }} />}
        {section === "Garantias" && <WarrantyView equipments={active} stores={stores} onOpen={(item) => { setSelected(item); setModal("details"); }} />}
        {section === "Auditoria" && <AuditView logs={auditLogs} stores={stores} types={types} />}
      </section>

      {modal && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
        {modal === "equipment" && <EquipmentForm key={editingEquipment?.id || "new"} item={editingEquipment || undefined} stores={stores} types={types} onSubmit={saveEquipment} onClose={() => { setEditingEquipment(null); setModal(null); }} onManageTypes={() => setModal("types")} />}
        {modal === "store" && <StoreForm key={editingStore?.id || "new"} store={editingStore || undefined} states={states} onSubmit={editingStore ? updateStore : addStore} onClose={() => { setEditingStore(null); setModal(null); }} />}
        {modal === "types" && <TypeManager types={types} onAdd={addType} onEdit={editType} onDelete={deleteType} onClose={() => setModal("equipment")} />}
        {modal === "details" && selected && <Details item={selected} store={stores.find((s) => s.id === selected.storeId)} onClose={() => setModal(null)} onEdit={() => requestEditEquipment(selected)} onToggle={() => toggleActive(selected)} onWarrantyAction={(action) => changeWarranty(selected, action)} />}
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

function StoresView({ stores, equipments, onOpen, onNew, onEdit, onDelete }: { stores: Store[]; equipments: Equipment[]; onOpen: (id: number) => void; onNew: () => void; onEdit: (store: Store) => void; onDelete: (store: Store) => void }) {
  const [search, setSearch] = useState("");
  const visibleStores = stores.filter((store) => `${store.name} ${store.city} ${store.state} ${store.address || ""}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="content">
    <div className="section-title"><div><h2>Lojas cadastradas</h2><p>Pesquise, edite ou consulte os equipamentos de cada unidade.</p></div><button className="primary" onClick={onNew}>+ Cadastrar loja</button></div>
    <label className="search store-search"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar loja por nome, cidade ou estado..." /></label>
    {visibleStores.length ? <div className="store-grid">{visibleStores.map((store) => {
      const items = equipments.filter((e) => e.storeId === store.id && e.active);
      return <article className="store-card" key={store.id}>
        <div className="store-card-top"><span>▦</span><small>{store.state}</small></div>
        <h3>{store.name}</h3><p>{store.city || "Cidade não informada"} · {store.state}</p>
        <div className="store-stats"><div><b>{items.length}</b><span>Ativos</span></div><div><b>{items.filter((e) => equipmentWarrantyState(e).className === "warning").length}</b><span>Em atenção</span></div></div>
        <button onClick={() => onOpen(store.id)}>Ver equipamentos <span>→</span></button>
        <div className="store-actions"><button onClick={() => onEdit(store)}>Editar</button><button className="danger-link" onClick={() => onDelete(store)}>Excluir</button></div>
      </article>;
    })}</div> : <div className="empty-state panel"><span>⌕</span><h3>Nenhuma loja encontrada.</h3><p>Altere o termo da busca.</p></div>}
  </div>;
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

function AuditView({ logs, stores, types }: { logs: AuditLog[]; stores: Store[]; types: EquipmentType[] }) {
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("ALL");
  const rows = logs.filter((log) => {
    const haystack = `${log.entityLabel} ${log.entityType} ${log.actorEmail} ${log.entityId}`.toLowerCase();
    return haystack.includes(search.toLowerCase()) && (action === "ALL" || log.action === action);
  });
  const fieldLabels: Record<string, string> = { name: "Nome", state: "Estado", city: "Cidade", address: "Endereço", store_id: "Loja", equipment_type_id: "Tipo", serial_number: "Número de série", purchase_date: "Data da compra", purchase_value: "Valor", warranty_start: "Início da garantia", warranty_end: "Término da garantia", extended_warranty_end: "Garantia estendida", warranty_closed: "Garantia encerrada", notes: "Observações", active: "Situação", reference_code: "Código da nota", file_name: "Documento" };
  const displayValue = (key: string, value: unknown) => {
    if (value === null || value === undefined || value === "") return "—";
    if (key === "store_id") return stores.find((store) => store.id === Number(value))?.name || `${value}`;
    if (key === "equipment_type_id") return types.find((type) => type.id === Number(value))?.name || `${value}`;
    if (["purchase_date", "warranty_start", "warranty_end", "extended_warranty_end"].includes(key)) return formatDate(`${value}`);
    if (key === "purchase_value") return money(Number(value));
    if (typeof value === "boolean") return value ? "Sim" : "Não";
    return `${value}`;
  };
  const changesFor = (log: AuditLog) => {
    const before = log.oldValues || {};
    const after = log.newValues || {};
    const ignored = new Set(["id", "owner_id", "created_at", "updated_at", "storage_path"]);
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !ignored.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    return keys.map((key) => ({ label: fieldLabels[key] || key, before: displayValue(key, before[key]), after: displayValue(key, after[key]) }));
  };
  const exportCsv = () => {
    const escape = (value: unknown) => `"${`${value ?? ""}`.replaceAll('"', '""')}"`;
    const header = ["Data", "Ação", "Entidade", "Registro", "Usuário", "Antes", "Depois"];
    const lines = rows.map((log) => [new Date(log.createdAt).toLocaleString("pt-BR"), log.action, log.entityType, log.entityLabel, log.actorEmail, JSON.stringify(log.oldValues || {}), JSON.stringify(log.newValues || {})].map(escape).join(";"));
    const blob = new Blob(["\ufeff", header.map(escape).join(";"), "\n", lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `auditoria-equipamentos-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const actionLabel = (value: AuditLog["action"]) => value === "INSERT" ? "Cadastro" : value === "UPDATE" ? "Alteração" : "Exclusão";
  return <div className="content">
    <div className="section-title"><div><h2>Log de auditoria</h2><p>Histórico permanente das alterações realizadas no sistema.</p></div><button className="secondary" onClick={exportCsv}>Exportar CSV</button></div>
    <div className="audit-filters"><label className="search"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar registro, usuário ou entidade..." /></label><select value={action} onChange={(e) => setAction(e.target.value)}><option value="ALL">Todas as ações</option><option value="INSERT">Cadastros</option><option value="UPDATE">Alterações</option><option value="DELETE">Exclusões</option></select></div>
    <div className="panel audit-list">{rows.length ? rows.map((log) => {
      const changes = changesFor(log);
      return <details key={log.id}><summary><span className={`audit-action ${log.action.toLowerCase()}`}>{actionLabel(log.action)}</span><div><b>{log.entityLabel || `${log.entityType} #${log.entityId}`}</b><small>{log.entityType} · {log.actorEmail}</small></div><time>{new Date(log.createdAt).toLocaleString("pt-BR")}</time></summary><div className="audit-changes">{changes.length ? changes.map((change) => <div key={change.label}><b>{change.label}</b><span>{change.before}</span><i>→</i><span>{change.after}</span></div>) : <p>Evento registrado sem alteração de campos exibíveis.</p>}</div></details>;
    }) : <div className="empty-state"><span>☷</span><h3>Nenhum registro encontrado.</h3><p>Altere os filtros ou realize uma nova operação.</p></div>}</div>
  </div>;
}

function EquipmentForm({ item, stores, types, onSubmit, onClose, onManageTypes }: { item?: Equipment; stores: Store[]; types: EquipmentType[]; onSubmit: (e: FormEvent<HTMLFormElement>) => void; onClose: () => void; onManageTypes: () => void }) {
  const [purchaseDate, setPurchaseDate] = useState(item?.purchaseDate || "");
  const [warrantyStart, setWarrantyStart] = useState(item?.warrantyStart || item?.purchaseDate || "");
  const suggestedEnd = addOneYear(item?.warrantyStart || item?.purchaseDate || "");
  const [warrantyEnd, setWarrantyEnd] = useState(item?.warrantyEnd || suggestedEnd);
  const [manualWarrantyEnd, setManualWarrantyEnd] = useState(Boolean(item?.warrantyEnd && item.warrantyEnd !== suggestedEnd));
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [referenceCode, setReferenceCode] = useState(item?.attachments.find((file) => file.referenceCode)?.referenceCode || "");
  const changePurchaseDate = (value: string) => {
    const previousPurchase = purchaseDate;
    setPurchaseDate(value);
    if (!warrantyStart || warrantyStart === previousPurchase) {
      setWarrantyStart(value);
      if (!manualWarrantyEnd) setWarrantyEnd(addOneYear(value));
    }
  };
  const changeWarrantyStart = (value: string) => {
    setWarrantyStart(value);
    if (!manualWarrantyEnd) setWarrantyEnd(addOneYear(value));
  };
  return <form className="modal large" onSubmit={onSubmit}>
    <ModalHead title={item ? "Editar equipamento" : "Novo equipamento"} subtitle={item ? "Altere todos os dados; o histórico será preservado." : "Cadastre os dados, a garantia e os documentos."} onClose={onClose} />
    <div className="form-grid">
      <label className="span-2">Nome do equipamento<input name="name" defaultValue={item?.name} placeholder="Ex.: Notebook Dell Inspiron" required /></label>
      <label>Tipo<select name="type" defaultValue={`${item?.typeId || types[0]?.id || ""}`} required><option value="" disabled>Selecione</option>{types.map((type) => <option value={type.id} key={type.id}>{type.name}</option>)}</select><button type="button" className="inline-link" onClick={onManageTypes}>Gerenciar e editar tipos</button></label>
      <label>Loja<select name="store" defaultValue={`${item?.storeId || stores[0]?.id || ""}`} required><option value="" disabled>Selecione</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name} — {store.state}</option>)}</select><small className="field-help">Ao trocar a loja, o sistema solicitará confirmação da migração.</small></label>
      <label>Número de série<input name="serial" defaultValue={item?.serial} placeholder="Digite o número de série" required /></label>
      <label>Data da compra<input name="purchaseDate" type="date" value={purchaseDate} onChange={(e) => changePurchaseDate(e.target.value)} required /><small className="field-help">Também preenche automaticamente o início da garantia.</small></label>
      <label>Valor (opcional)<input name="value" type="number" min="0" step="0.01" defaultValue={item?.value || ""} placeholder="0,00" /></label>
      <label>Início da garantia<input name="warrantyStart" type="date" value={warrantyStart} onChange={(e) => changeWarrantyStart(e.target.value)} /><small className="field-help">Igual à compra por padrão; pode ser alterado.</small></label>
      <label>Término da garantia<input name="warrantyEnd" type="date" value={warrantyEnd} onChange={(e) => { setWarrantyEnd(e.target.value); setManualWarrantyEnd(true); }} /><small className="field-help">Calculado automaticamente em 1 ano; edição manual permitida.</small></label>
      <label>Garantia estendida até (opcional)<input name="extendedWarrantyEnd" type="date" defaultValue={item?.extendedWarrantyEnd} /><small className="field-help">Esta data passa a ser o vencimento efetivo.</small></label>
      <label className="span-2">Código compartilhado da nota (#)<input name="referenceCode" value={referenceCode} onChange={(e) => setReferenceCode(e.target.value)} onBlur={() => setReferenceCode(normalizeReference(referenceCode))} placeholder="#NF-2026-001" /><small className="field-help">Use o mesmo código em vários equipamentos para vincular a mesma nota fiscal sem reenviar o arquivo.</small></label>
      <label className="span-2">Notas fiscais e documentos<input className="file-input" name="files" type="file" accept=".pdf,.jpg,.jpeg,.png" multiple onChange={(e) => setSelectedFiles(Array.from(e.target.files || []))} /><small className="field-help">PDF, JPG ou PNG. {item?.attachments.length ? `${item.attachments.length} documento(s) já vinculado(s); novos arquivos serão acrescentados.` : "Selecione a nota e a garantia estendida."}</small></label>
      {selectedFiles.length > 0 && <LocalFilesPreview files={selectedFiles} />}
      <label className="span-2">Observações<textarea name="notes" defaultValue={item?.notes} placeholder="Informações adicionais sobre o equipamento..." /></label>
    </div>
    <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary">{item ? "Salvar alterações" : "Salvar equipamento"}</button></div>
  </form>;
}

function LocalFilesPreview({ files }: { files: File[] }) {
  return <div className="span-2 local-previews">{files.map((file) => <LocalFilePreview file={file} key={`${file.name}-${file.size}-${file.lastModified}`} />)}</div>;
}

function LocalFilePreview({ file }: { file: File }) {
  const url = useMemo(() => file.type.startsWith("image/") ? URL.createObjectURL(file) : "", [file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return <div>{url ? <img src={url} alt={`Prévia de ${file.name}`} /> : <span className="pdf-preview">PDF</span>}<p><b>{file.name}</b><small>{bytes(file.size)}</small></p></div>;
}

function StoreForm({ store, states, onSubmit, onClose }: { store?: Store; states: string[]; onSubmit: (e: FormEvent<HTMLFormElement>) => void; onClose: () => void }) {
  return <form className="modal" onSubmit={onSubmit}><ModalHead title={store ? "Editar loja" : "Cadastrar loja"} subtitle={store ? "Todas as alterações serão registradas na auditoria." : "Adicione uma nova unidade ao sistema."} onClose={onClose} /><div className="form-grid"><label className="span-2">Nome da loja<input name="name" defaultValue={store?.name} placeholder="Ex.: Loja Aram" required /></label><label>Estado (sigla)<input name="state" defaultValue={store?.state} maxLength={2} pattern="[A-Za-z]{2}" placeholder="RN" list="states" required /><datalist id="states">{states.map((state) => <option key={state}>{state}</option>)}</datalist></label><label>Cidade (opcional)<input name="city" defaultValue={store?.city} placeholder="Natal" /></label><label className="span-2">Endereço (opcional)<input name="address" defaultValue={store?.address} placeholder="Rua, número e bairro" /></label></div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button className="primary">{store ? "Salvar alterações" : "Cadastrar loja"}</button></div></form>;
}

function TypeManager({ types, onAdd, onEdit, onDelete, onClose }: { types: EquipmentType[]; onAdd: (value: string) => void | Promise<void>; onEdit: (type: EquipmentType, value: string) => void | Promise<void>; onDelete: (type: EquipmentType) => void | Promise<void>; onClose: () => void }) {
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  return <section className="modal compact"><ModalHead title="Gerenciar tipos" subtitle="Cadastre, renomeie ou exclua categorias sem uso." onClose={onClose} /><form className="type-add" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { void onAdd(name); setName(""); } }}><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Câmera fotográfica" required /><button className="primary">Adicionar</button></form><div className="type-list">{types.map((type) => <div key={type.id}>{editingId === type.id ? <input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus /> : <b>{type.name}</b>}<span>{editingId === type.id ? <><button onClick={() => { void onEdit(type, draft); setEditingId(null); }}>Salvar</button><button onClick={() => setEditingId(null)}>Cancelar</button></> : <><button onClick={() => { setEditingId(type.id); setDraft(type.name); }}>Editar</button><button className="danger-link" onClick={() => void onDelete(type)}>Excluir</button></>}</span></div>)}</div><div className="modal-actions"><button className="secondary" onClick={onClose}>Voltar</button></div></section>;
}

function ModalHead({ title, subtitle, onClose }: { title: string; subtitle: string; onClose: () => void }) { return <div className="modal-head"><div><h2>{title}</h2><p>{subtitle}</p></div><button type="button" onClick={onClose}>×</button></div>; }

function DocumentPreview({ file, onClose }: { file: Attachment; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    if (!supabase || !file.path) {
      queueMicrotask(() => setError("Arquivo não encontrado."));
      return () => { active = false; };
    }
    void supabase.storage.from(documentsBucket).download(file.path).then(({ data, error: downloadError }) => {
      if (!active) return;
      if (downloadError || !data) setError("Não foi possível carregar a prévia.");
      else { objectUrl = URL.createObjectURL(data); setUrl(objectUrl); }
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file]);
  return <div className="document-preview"><div><b>Prévia: {file.name}</b><button onClick={onClose}>Fechar prévia</button></div>{error ? <p className="form-error">{error}</p> : !url ? <p className="muted">Carregando prévia...</p> : file.type === "application/pdf" ? <iframe src={url} title={`Prévia de ${file.name}`} /> : <img src={url} alt={`Prévia de ${file.name}`} />}</div>;
}

function Details({ item, store, onClose, onEdit, onToggle, onWarrantyAction }: { item: Equipment; store?: Store; onClose: () => void; onEdit: () => void; onToggle: () => void; onWarrantyAction: (action: "start" | "end") => void }) {
  const state = equipmentWarrantyState(item);
  const [preview, setPreview] = useState<Attachment | null>(null);
  return <section className="modal large details"><ModalHead title={item.name} subtitle={`${item.type} · ${item.serial}`} onClose={onClose} /><div className="details-top"><span className={`pill ${item.active ? "success" : "neutral"}`}>{item.active ? "Equipamento ativo" : "Equipamento inativo"}</span><span className={`pill ${state.className}`}>{state.label}</span>{item.extendedWarrantyEnd && <span className="pill extended">Garantia estendida</span>}<button className="edit-detail" onClick={onEdit}>Editar todas as informações</button></div><div className="detail-grid"><div><span>Loja</span><b>{store?.name}</b><small>{store?.city} · {store?.state}</small></div><div><span>Número de série</span><b className="serial">{item.serial}</b></div><div><span>Data da compra</span><b>{formatDate(item.purchaseDate)}</b></div><div><span>Valor</span><b>{money(item.value)}</b></div><div><span>Início da garantia</span><b>{formatDate(item.warrantyStart)}</b></div><div><span>Término da garantia</span><b>{formatDate(item.warrantyEnd)}</b>{item.extendedWarrantyEnd && <small>Estendida até {formatDate(item.extendedWarrantyEnd)}</small>}</div></div><div className="documents"><h3>Documentos anexados</h3>{item.attachments.length ? item.attachments.map((file) => <div className="document" key={file.id}><span>▤</span><div><b>{file.name}</b><small>{file.kind} · {bytes(file.size)} {file.referenceCode ? `· ${file.referenceCode}` : ""}</small></div><div className="document-actions"><button onClick={() => setPreview(file)}>Pré-visualizar</button><button onClick={() => viewDocument(file)}>Abrir</button></div></div>) : <p className="muted">Nenhum documento anexado.</p>}</div>{preview && <DocumentPreview file={preview} onClose={() => setPreview(null)} />}{item.notes && <div className="notes"><span>Observações</span><p>{item.notes}</p></div>}<div className="modal-actions detail-actions"><button className={item.active ? "danger-button" : "secondary"} onClick={onToggle}>{item.active ? "Mover para inativos" : "Reativar equipamento"}</button><div><button className="warranty-button start" onClick={() => onWarrantyAction("start")}>Iniciar garantia</button><button className="warranty-button end" onClick={() => onWarrantyAction("end")}>Encerrar garantia</button><button className="primary" onClick={onClose}>Fechar</button></div></div></section>;
}
