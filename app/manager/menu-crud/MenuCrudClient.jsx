'use client';

/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element */

import { useState, useEffect, useTransition, useRef, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createCategory, deleteCategory, createMenuItem, updateMenuItem, deleteMenuItem } from './actions';
import LanguageToggle from '@/app/components/LanguageToggle';
import { useLanguage } from '@/app/components/LanguageProvider';
import ThemeToggleHome from '@/app/components/ThemeToggleHome';

// Exact same pill & card constants as /manager/reports
const PILL_ACTIVE =
  'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner';
const PILL_INACTIVE =
  'bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner';
const CARD =
  'rounded-2xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out   hover:shadow-[0_14px_30px_-5px_rgba(0,0,0,0.08),0_10px_12px_-6px_rgba(0,0,0,0.04)] dark:hover:shadow-[0_16px_36px_rgba(0,0,0,0.55)]   active:shadow-inner';
const HEADER_CARD =
  'rounded-2xl bg-white dark:bg-[#1C1D24] px-4 py-3 border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner sm:px-6';
const BTN_PRIMARY =
  'flex h-10 items-center gap-1.5 rounded-full bg-[#FFD600] dark:bg-[#FF5E00] px-4 text-xs font-bold uppercase tracking-wide text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner';
const BTN_SECONDARY =
  'flex h-10 items-center gap-1.5 rounded-full bg-white dark:bg-[#1C1D24] px-4 text-xs font-bold uppercase tracking-wide text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner hover:bg-[#F8FAFC] dark:hover:bg-[#252631]';

function TogglePill({ checked, onChange, label }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wide transition-all ${checked ? PILL_ACTIVE : PILL_INACTIVE}`}
    >
      <span className={`flex h-3 w-3 items-center justify-center rounded-full border-2 ${checked ? 'bg-[#FFD600] dark:bg-[#FF5E00] border-[#FFD600] dark:border-[#FF5E00]' : 'border-[#CBD5E1] dark:border-[#2A2B36]'}`}>
        {checked && <span className="h-1.5 w-1.5 rounded-full bg-[#1E293B] dark:bg-white block" />}
      </span>
      {label}
    </button>
  );
}



export default function MenuCrudClient({ initialCategories, initialItems, source }) {
  const router = useRouter();
  const { t } = useLanguage();
  const [categories, setCategories] = useState(initialCategories || []);
  const [items, setItems] = useState(initialItems || []);
  const [isPending, startTransition] = useTransition();
  const [activeTab, setActiveTab] = useState('KITCHEN'); // Foods = KITCHEN, Drinks = BARISTA
  const [dietFilter, setDietFilter] = useState('all'); // 'all' | 'fasting' | 'nonFasting'
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileNavRef = useRef(null);

  // Sync when server data changes (revalidate)
  useEffect(() => { setCategories(initialCategories || []); }, [initialCategories]);
  useEffect(() => { setItems(initialItems || []); }, [initialItems]);

  useEffect(() => {
    function onDoc(e) {
      if (mobileNavRef.current && !mobileNavRef.current.contains(e.target)) setMobileNavOpen(false);
    }
    function onResize() {
      if (typeof window !== 'undefined' && window.innerWidth >= 768) setMobileNavOpen(false);
    }
    if (mobileNavOpen) document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('resize', onResize);
    };
  }, [mobileNavOpen]);

  // Filtered by station tab
  const filteredCategories = categories.filter((c) => {
    const st = c.targetStation || c.station || (c.type === 'DRINK' ? 'BARISTA' : 'KITCHEN');
    return st === activeTab;
  });
  const filteredItems = items.filter((i) => {
    const st = i.targetStation || i.station || (i.categoryType === 'DRINK' ? 'BARISTA' : 'KITCHEN');
    if (st !== activeTab) return false;
    if (dietFilter === 'fasting') return !!i.isFasting;
    if (dietFilter === 'nonFasting') return !!i.isNonFasting;
    return true;
  });

  // Presentation-layer A→Z ordering by the displayed (English) name.
  // Case-insensitive, deterministic, never mutates the source array; the API
  // response and database ordering remain untouched.
  const sortedItems = [...filteredItems].sort((a, b) => {
    const an = String(a.nameEn || a.name?.en || '').trim();
    const bn = String(b.nameEn || b.name?.en || '').trim();
    const cmp = an.localeCompare(bn, undefined, { sensitivity: 'base' });
    return cmp !== 0 ? cmp : String(a._id).localeCompare(String(b._id));
  });

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setEditingId(null);
    setForm({
      nameEn: '', nameAm: '', nameOm: '',
      descriptionEn: '', descriptionAm: '', descriptionOm: '',
      price: '', category: '', categoryId: '', image: '',
      isSpecial: false, isNew: false, isAvailable: true,
      isFasting: false, isNonFasting: false
    });
    setPreviewUrl('');
    setImageFile(null);
    if (fileRef.current) fileRef.current.value = '';
    setFormError('');
    setFormSuccess('');
  };

  // Category form
  const [catName, setCatName] = useState('');
  const [catError, setCatError] = useState('');
  const [catSuccess, setCatSuccess] = useState('');

  // Item form
  const [editingId, setEditingId] = useState(null);
  const editingItem = editingId ? items.find(i => String(i._id) === String(editingId)) : null;
  const [form, setForm] = useState({
    nameEn: '', nameAm: '', nameOm: '',
    descriptionEn: '', descriptionAm: '', descriptionOm: '',
    price: '',
    category: '',
    isSpecial: false, isNew: false, isAvailable: true, isFasting: false, isNonFasting: true,
  });
  const [imageFile, setImageFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const fileRef = useRef(null);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');
  const [showCategoryManager, setShowCategoryManager] = useState(false);

  // Payment Information CRUD state
  const [paymentInfos, setPaymentInfos] = useState([]);
  const [showPaymentManager, setShowPaymentManager] = useState(false);
  const [payForm, setPayForm] = useState({ bankName: '', ownerName: '', accountNumber: '', isActive: true });
  const [editingPayId, setEditingPayId] = useState(null);
  const [payError, setPayError] = useState('');
  const [paySuccess, setPaySuccess] = useState('');
  const [payLoading, setPayLoading] = useState(false);

  // Branding CRUD state
  const [showBrandingManager, setShowBrandingManager] = useState(false);
  const [brandForm, setBrandForm] = useState({ name: '', logoPath: '' });
  const [logoFile, setLogoFile] = useState(null);
  const [logoPreview, setLogoPreview] = useState('');
  const fileInputRef = useRef(null);
  const [brandError, setBrandError] = useState('');
  const [brandSuccess, setBrandSuccess] = useState('');
  const [brandLoading, setBrandLoading] = useState(false);

  // Tab switch handled via handleTabChange — no form reset here to avoid infinite loop

  function handleImageChange(e) {
    const file = e.target.files?.[0] || null;
    setImageFile(file);
    if (file) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
    } else {
      setPreviewUrl(editingItem?.imageUrl || '');
    }
  }

  async function handleCreateCategory(e) {
    e.preventDefault();
    setCatError(''); setCatSuccess('');
    if (!catName.trim()) { setCatError(t('nameRequired')); return; }
    startTransition(async () => {
      const fd = new FormData();
      fd.set('name', catName.trim());
      fd.set('targetStation', activeTab);
      const res = await createCategory(null, fd);
      if (!res.success) setCatError(res.error);
      else {
        setCatSuccess(res.message);
        setCatName('');
        // Optimistic update with correct station
        if (res.category) {
          const station = res.category.targetStation || activeTab;
          setCategories(prev => [...prev, { _id: res.category._id, name: res.category.name, slug: res.category.slug, type: station === 'BARISTA' ? 'DRINK' : 'FOOD', targetStation: station, station }]);
        }
        router.refresh();
      }
    });
  }

  async function handleDeleteCategory(id, name) {
    if (!confirm(`${t('confirmDeleteCategory')} "${name}"?`)) return;
    startTransition(async () => {
      const fd = new FormData();
      fd.set('id', id);
      const res = await deleteCategory(fd);
      if (!res.success) alert(res.error);
      else {
        setCategories(prev => prev.filter(c => String(c._id) !== String(id)));
        router.refresh();
      }
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(''); setFormSuccess('');
    // Validation
    if (!form.nameEn.trim() && !form.nameAm.trim() && !form.nameOm.trim()) {
      setFormError(t('nameRequiredMulti')); return;
    }
    if (!form.category) { setFormError(t('categoryRequired')); return; }
    const priceNum = Number(form.price);
    if (!Number.isFinite(priceNum) || priceNum < 0) { setFormError(t('priceNonNegative')); return; }

    const fd = new FormData();
    fd.set('nameEn', form.nameEn.trim());
    fd.set('nameAm', form.nameAm.trim());
    fd.set('nameOm', form.nameOm.trim());
    fd.set('descriptionEn', form.descriptionEn.trim());
    fd.set('descriptionAm', form.descriptionAm.trim());
    fd.set('descriptionOm', form.descriptionOm.trim());
    fd.set('price', String(priceNum));
    fd.set('category', form.category);
    fd.set('targetStation', activeTab);
    if (form.isSpecial) fd.set('isSpecial', 'true');
    if (form.isNew) fd.set('isNew', 'true');
    if (form.isAvailable) fd.set('isAvailable', 'true');
    else fd.set('isAvailable', 'false');
    if (form.isFasting) fd.set('isFasting', 'true');
    if (form.isNonFasting) fd.set('isNonFasting', 'true');
    if (imageFile) fd.set('image', imageFile);
    if (editingItem?.imageUrl) fd.set('existingImageUrl', editingItem.imageUrl);

    startTransition(async () => {
      let res;
      if (editingId) {
        fd.set('id', editingId);
        res = await updateMenuItem(null, fd);
      } else {
        res = await createMenuItem(null, fd);
      }
      if (!res.success) setFormError(res.error);
      else {
        setFormSuccess(res.message);
        // Optimistic local update for instant feedback (server revalidation follows)
        if (!editingId) {
          const catName = categories.find(c => String(c._id) === String(form.category))?.name || '';
          const optimistic = {
            _id: res.itemId || `temp-${Date.now()}`,
            id: res.itemId || `temp-${Date.now()}`,
            nameEn: form.nameEn.trim(),
            nameAm: form.nameAm.trim(),
            nameOm: form.nameOm.trim(),
            name: { en: form.nameEn.trim(), am: form.nameAm.trim(), om: form.nameOm.trim() },
            descriptionEn: form.descriptionEn.trim(),
            descriptionAm: form.descriptionAm.trim(),
            descriptionOm: form.descriptionOm.trim(),
            description: { en: form.descriptionEn.trim(), am: form.descriptionAm.trim(), om: form.descriptionOm.trim() },
            price: priceNum,
            category: form.category,
            categoryId: form.category,
            categoryName: catName,
            imageUrl: previewUrl || '/placeholders/food.svg',
            image: previewUrl || '/placeholders/food.svg',
            isSpecial: form.isSpecial,
            isNew: form.isNew,
            isAvailable: form.isAvailable,
            isFasting: form.isFasting,
            isNonFasting: form.isNonFasting,
            targetStation: activeTab,
            station: activeTab,
            categoryType: activeTab === 'BARISTA' ? 'DRINK' : 'FOOD',
          };
          setItems(prev => [optimistic, ...prev]);
        } else {
          const catName = categories.find(c => String(c._id) === String(form.category))?.name || '';
          setItems(prev => prev.map(i => String(i._id) === String(editingId) ? {
            ...i,
            nameEn: form.nameEn.trim() || i.nameEn,
            nameAm: form.nameAm.trim() || i.nameAm,
            nameOm: form.nameOm.trim() || i.nameOm,
            price: priceNum,
            category: form.category || i.category,
            categoryId: form.category || i.categoryId,
            categoryName: catName || i.categoryName,
            imageUrl: previewUrl || i.imageUrl,
            image: previewUrl || i.image,
            isSpecial: form.isSpecial,
            isNew: form.isNew,
            isAvailable: form.isAvailable,
            isFasting: form.isFasting,
            isNonFasting: form.isNonFasting,
            targetStation: activeTab,
            station: activeTab,
            categoryType: activeTab === 'BARISTA' ? 'DRINK' : 'FOOD',
          } : i));
          setEditingId(null);
        }
        // Reset form if created
        if (!editingId) {
          setForm({
            nameEn: '', nameAm: '', nameOm: '',
            descriptionEn: '', descriptionAm: '', descriptionOm: '',
            price: '',
            category: filteredCategories[0]?._id ? String(filteredCategories[0]._id) : '',
            isSpecial: false, isNew: false, isAvailable: true, isFasting: false, isNonFasting: true,
          });
          setImageFile(null); setPreviewUrl('');
          if (fileRef.current) fileRef.current.value = '';
        }
        // Phase 5: single targeted revalidation (was double refresh + 800ms duplicate)
        router.refresh();
      }
    });
  }

  const handleEditItem = (item) => {
    setEditingId(String(item._id));
    setForm({
      nameEn: item.nameEn || item.name?.en || '',
      nameAm: item.nameAm || item.name?.am || '',
      nameOm: item.nameOm || item.name?.om || '',
      descriptionEn: item.descriptionEn || item.description?.en || '',
      descriptionAm: item.descriptionAm || item.description?.am || '',
      descriptionOm: item.descriptionOm || item.description?.om || '',
      price: String(item.price ?? ''),
      category: String(item.category || item.categoryId || ''),
      isSpecial: !!item.isSpecial,
      isNew: !!(item.isNew || item.isItemNew),
      isAvailable: item.isAvailable !== false,
      isFasting: !!item.isFasting,
      isNonFasting: item.isNonFasting !== undefined ? !!item.isNonFasting : !item.isFasting,
    });
    setPreviewUrl(item.imageUrl || item.image || '');
    setImageFile(null);
    if (fileRef.current) fileRef.current.value = '';
    setFormError('');
    setFormSuccess('');
  };

  async function handleDelete(item) {
    if (!confirm(t('confirmDeleteItem'))) return;
    startTransition(async () => {
      const res = await deleteMenuItem(String(item._id));
      if (!res.success) alert(res.error);
      else {
        setItems(prev => prev.filter(i => String(i._id) !== String(item._id)));
        if (editingId && String(editingId) === String(item._id)) setEditingId(null);
        router.refresh();
      }
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setFormError(''); setFormSuccess('');
  }

  // Fetch payment infos when the manager is opened
  useEffect(() => {
    if (showPaymentManager) fetchPaymentInfos();
  }, [showPaymentManager]);

  async function fetchPaymentInfos() {
    try {
      const res = await fetch('/api/payment-info', { cache: 'no-store', credentials: 'include' });
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch {} }
      if (res.ok && data?.success) {
        setPaymentInfos(data.data.paymentInfos || []);
      }
    } catch {}
  }

  async function handleCreatePayment(e) {
    e.preventDefault();
    setPayError(''); setPaySuccess('');
    if (!payForm.bankName.trim() || !payForm.ownerName.trim() || !payForm.accountNumber.trim()) {
      setPayError(t('payRequired'));
      return;
    }
    setPayLoading(true);
    try {
      const res = await fetch('/api/payment-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          bankName: payForm.bankName.trim(),
          ownerName: payForm.ownerName.trim(),
          accountNumber: payForm.accountNumber.trim(),
          isActive: payForm.isActive,
        }),
      });
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch {} }
      if (!res.ok || !data?.success) {
        setPayError(data?.error || t('paySaveFailed'));
      } else {
        setPaySuccess(`${data.data.paymentInfo.bankName} saved`);
        setPayForm({ bankName: '', ownerName: '', accountNumber: '', isActive: true });
        setEditingPayId(null);
        await fetchPaymentInfos();
      }
      } catch {
        setPayError(t('networkError'));
    } finally {
      setPayLoading(false);
    }
  }

  async function handleUpdatePayment(e) {
    e.preventDefault();
    setPayError(''); setPaySuccess('');
    if (!payForm.bankName.trim() || !payForm.ownerName.trim() || !payForm.accountNumber.trim()) {
      setPayError(t('payRequired'));
      return;
    }
    setPayLoading(true);
    try {
      const res = await fetch(`/api/payment-info?id=${editingPayId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          bankName: payForm.bankName.trim(),
          ownerName: payForm.ownerName.trim(),
          accountNumber: payForm.accountNumber.trim(),
          isActive: payForm.isActive,
        }),
      });
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch {} }
      if (!res.ok || !data?.success) {
        setPayError(data?.error || t('payUpdateFailed'));
      } else {
        setPaySuccess(`${data.data.paymentInfo.bankName} updated`);
        setPayForm({ bankName: '', ownerName: '', accountNumber: '', isActive: true });
        setEditingPayId(null);
        await fetchPaymentInfos();
      }
      } catch {
        setPayError(t('networkError'));
    } finally {
      setPayLoading(false);
    }
  }

  function handleEditPayment(p) {
    setEditingPayId(p._id);
    setPayForm({
      bankName: p.bankName || '',
      ownerName: p.ownerName || '',
      accountNumber: p.accountNumber || '',
      isActive: p.isActive !== false,
    });
    setPayError(''); setPaySuccess('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Fetch current branding when the manager is opened
  useEffect(() => {
    if (showBrandingManager) fetchBranding();
  }, [showBrandingManager]);

  async function fetchBranding() {
    try {
      const res = await fetch('/api/brand', { cache: 'no-store', credentials: 'include' });
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch {} }
      if (res.ok && data?.success) {
        const b = data.data.brand || { name: '', logoPath: '' };
        setBrandForm({ name: b.name || '', logoPath: b.logoPath || '' });
      }
    } catch {}
  }

  function handleLogoFileChange(e) {
    const file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
    setLogoFile(file);
    setLogoPreview(file ? URL.createObjectURL(file) : '');
  }

  async function handleSaveBranding(e) {
    e.preventDefault();
    setBrandError(''); setBrandSuccess('');
    if (!brandForm.name.trim()) {
      setBrandError(t('brandNameRequired'));
      return;
    }
    setBrandLoading(true);
    try {
      let logoPath = brandForm.logoPath || '';
      if (logoFile) {
        const fd = new FormData();
        fd.set('file', logoFile);
        const upRes = await fetch('/api/brand/upload', { method: 'POST', body: fd, credentials: 'include' });
        const upText = await upRes.text();
        let upData = null;
        if (upText) { try { upData = JSON.parse(upText); } catch {} }
        if (!upRes.ok || !upData?.success) {
          // Surface the actual failure (HTTP status / server message) instead of
          // hiding it behind a generic "Failed to upload image" — e.g. a proxy 413
          // returns a non-JSON body that would otherwise be masked.
          const msg =
            upData?.error ||
            (upText ? `Upload failed (HTTP ${upRes.status}): ${upText.slice(0, 200)}` : t('uploadFailed'));
          setBrandError(msg);
          setBrandLoading(false);
          return;
        }
        logoPath = upData.data.logoPath;
      }
      const res = await fetch('/api/brand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: brandForm.name.trim(),
          logoPath,
        }),
      });
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch {} }
      if (!res.ok || !data?.success) {
        setBrandError(data?.error || t('brandSaveFailed'));
      } else {
        setBrandForm((f) => ({ ...f, logoPath }));
        setBrandSuccess(t('brandingUpdated'));
        setLogoFile(null);
        setLogoPreview('');
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    } catch {
      setBrandError(t('networkError'));
    } finally {
      setBrandLoading(false);
    }
  }

  async function handleDeletePayment(p) {
    if (!confirm(t('confirmDeletePayment'))) return;
    setPayLoading(true);
    try {
      const res = await fetch(`/api/payment-info?id=${p._id}`, { method: 'DELETE', credentials: 'include' });
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch {} }
      if (!res.ok || !data?.success) {
        alert(data?.error || 'Failed to delete');
      } else {
        setPaymentInfos(prev => prev.filter(x => String(x._id) !== String(p._id)));
      }
    } catch {
      alert('Network error — please retry');
    } finally {
      setPayLoading(false);
    }
  }

  // Single shared item-form instance. Rendered at page level for CREATE; while
  // EDITING it renders inline at the selected item's own row/card so the edit
  // UI stays attached to that item (same state + update handler, no duplicates).
  const itemForm = (
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Names — 3 languages */}
          <div className="rounded-xl bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] p-4">
            <p className="text-xs font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8] mb-3">{t('namesSection')}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-bold text-[#64748B] dark:text-[#94A3B8] mb-1">{t('langEnglish')} *</label>
                <input value={form.nameEn} onChange={e => setForm(f => ({ ...f, nameEn: e.target.value }))} placeholder={activeTab === 'BARISTA' ? 'e.g. Macchiato' : 'e.g. Doro Wot'} className="w-full rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-2.5 text-sm text-[#1E293B] dark:text-white placeholder:text-[#64748B]/60 dark:placeholder:text-[#94A3B8]/60 focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40" />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#64748B] dark:text-[#94A3B8] mb-1">{t('langAmharic')}</label>
                <input value={form.nameAm} onChange={e => setForm(f => ({ ...f, nameAm: e.target.value }))} placeholder={activeTab === 'BARISTA' ? 'e.g. ማክያቶ' : 'ዶሮ ወጥ'} className="w-full rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-2.5 text-sm text-[#1E293B] dark:text-white placeholder:text-[#64748B]/60 dark:placeholder:text-[#94A3B8]/60 focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40" />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#64748B] dark:text-[#94A3B8] mb-1">{t('langOromo')}</label>
                <input value={form.nameOm} onChange={e => setForm(f => ({ ...f, nameOm: e.target.value }))} placeholder={activeTab === 'BARISTA' ? 'e.g. Macchiato' : 'Doro Wot'} className="w-full rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-2.5 text-sm text-[#1E293B] dark:text-white placeholder:text-[#64748B]/60 dark:placeholder:text-[#94A3B8]/60 focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40" />
              </div>
            </div>
          </div>

          {/* Descriptions — 3 languages */}
          <div className="rounded-xl bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] p-4">
            <p className="text-xs font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8] mb-3">{t('descriptionsSection')}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-bold text-[#64748B] dark:text-[#94A3B8] mb-1">{t('langEnglish')}</label>
                <textarea value={form.descriptionEn} onChange={e => setForm(f => ({ ...f, descriptionEn: e.target.value }))} placeholder={activeTab === 'BARISTA' ? 'Macchiato — rich espresso topped with velvety steamed milk...' : 'Spicy chicken stew...'} rows={3} className="w-full rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-2.5 text-sm text-[#1E293B] dark:text-white placeholder:text-[#64748B]/60 dark:placeholder:text-[#94A3B8]/60 focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40 resize-none" />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#64748B] dark:text-[#94A3B8] mb-1">{t('langAmharic')}</label>
                <textarea value={form.descriptionAm} onChange={e => setForm(f => ({ ...f, descriptionAm: e.target.value }))} placeholder={activeTab === 'BARISTA' ? 'የማክያቶ መግለጫ...' : 'የዶሮ ወጥ መግለጫ...'} rows={3} className="w-full rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-2.5 text-sm text-[#1E293B] dark:text-white placeholder:text-[#64748B]/60 dark:placeholder:text-[#94A3B8]/60 focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40 resize-none" />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#64748B] dark:text-[#94A3B8] mb-1">{t('langOromo')}</label>
                <textarea value={form.descriptionOm} onChange={e => setForm(f => ({ ...f, descriptionOm: e.target.value }))} placeholder={activeTab === 'BARISTA' ? 'Ibsa Maakiyaattoo...' : 'Ibsa Doro Wot...'} rows={3} className="w-full rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-2.5 text-sm text-[#1E293B] dark:text-white placeholder:text-[#64748B]/60 dark:placeholder:text-[#94A3B8]/60 focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40 resize-none" />
              </div>
            </div>
          </div>

          {/* Price, Category, Image */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-xl bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] p-4">
              <label className="block text-xs font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8] mb-2">{t('priceLabel')} *</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-[#64748B] dark:text-[#94A3B8]">ETB</span>
                <input type="number" min="0" step="0.01" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} placeholder="450" className="w-full rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] pl-12 pr-3 py-3 text-sm font-bold text-[#1E293B] dark:text-white placeholder:text-[#64748B]/60 dark:placeholder:text-[#94A3B8]/60 focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40" />
              </div>
            </div>

            <div className="rounded-xl bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] p-4">
              <label className="block text-xs font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8] mb-2">{t('category')} *</label>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className="w-full rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-3 text-sm text-[#1E293B] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40">
                <option value="">{t('selectCategory')}</option>
                {filteredCategories.map(cat => (
                  <option key={String(cat._id)} value={String(cat._id)}>{cat.name} — {cat.slug}</option>
                ))}
              </select>
                  {filteredCategories.length === 0 && <p className="mt-1 text-xs font-semibold text-amber-600 dark:text-amber-400">{t('createCategoryFirst')}</p>}
            </div>

            <div className="rounded-xl bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] p-4">
              <label className="block text-xs font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8] mb-2">{t('imageUpload')}</label>
              <input ref={fileRef} type="file" accept="image/*" onChange={handleImageChange} className="block w-full text-xs text-[#64748B] dark:text-[#94A3B8] file:mr-3 file:rounded-full file:border-0 file:bg-[#FFD600] dark:file:bg-[#FF5E00] file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-[#1E293B] dark:file:text-white hover:file:opacity-90 dark:hover:file:opacity-80 file:transition" />
              <p className="mt-1 text-[10px] text-[#64748B] dark:text-[#94A3B8]">{t('imageFormatHint')}</p>
              {previewUrl && (
                <div className="mt-3 relative h-24 w-full overflow-hidden rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A]">
                  <img src={previewUrl} alt="Preview" className="h-full w-full object-cover" />
                </div>
              )}
            </div>
          </div>

          {/* Toggles — pills */}
          <div className="rounded-xl bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] p-4">
            <p className="text-xs font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8] mb-3">{t('visibilitySection')}</p>
            <div className="flex flex-wrap gap-2">
              <TogglePill checked={form.isSpecial} onChange={v => setForm(f => ({ ...f, isSpecial: v }))} label={t('markSpecial')} />
              <TogglePill checked={form.isNew} onChange={v => setForm(f => ({ ...f, isNew: v }))} label={t('markNew')} />
              <TogglePill checked={form.isAvailable} onChange={v => setForm(f => ({ ...f, isAvailable: v }))} label={t('available')} />
              <TogglePill checked={form.isFasting} onChange={v => setForm(f => ({ ...f, isFasting: v }))} label={t('fasting')} />
              <TogglePill checked={form.isNonFasting} onChange={v => setForm(f => ({ ...f, isNonFasting: v }))} label={t('nonFasting')} />
            </div>
          </div>

          {formError && <div className="rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 px-4 py-3 text-sm font-semibold text-red-600 dark:text-red-300">{formError}</div>}
          {formSuccess && <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 px-4 py-3 text-sm font-semibold text-emerald-700 dark:text-emerald-300">{formSuccess}</div>}

          <div className="flex gap-3">
            <button type="submit" disabled={isPending} className={BTN_PRIMARY + ' flex-1 justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed'}>
              {isPending ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#1E293B]/30 dark:border-white/30 border-t-[#1E293B] dark:border-t-white" />
                  {editingId ? t('updating') : t('creating')}
                </>
              ) : (
                <>{editingId ? t('updateMenuBtn') : t('createMenuBtn')}</>
              )}
            </button>
            {editingId && (
              <button type="button" onClick={cancelEdit} className={BTN_SECONDARY}>{t('cancel')}</button>
            )}
          </div>
        </form>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      {/* HEADER — harmonized with /manager/reports */}
      <header className={`${HEADER_CARD} relative`}>
        {/* DESKTOP */}
        <div className="hidden md:flex md:flex-wrap md:items-center md:justify-between md:gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold text-[#1E293B] dark:text-white sm:text-2xl">
              {t('menuManagement')}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-1 rounded-full bg-[#F4F5F9] dark:bg-[#12131A] p-1 border border-[#E2E8F0]/60 dark:border-[#2A2B36]">
              <button type="button" onClick={() => handleTabChange('KITCHEN')} className={`px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wide transition-all ${activeTab === 'KITCHEN' ? 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-sm' : 'bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white/80 border border-[#E2E8F0]/60 dark:border-[#2A2B36] hover:bg-[#F8FAFC] dark:hover:bg-[#252631]'}`}>{t('food')}</button>
              <button type="button" onClick={() => handleTabChange('BARISTA')} className={`px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wide transition-all ${activeTab === 'BARISTA' ? 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-sm' : 'bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white/80 border border-[#E2E8F0]/60 dark:border-[#2A2B36] hover:bg-[#F8FAFC] dark:hover:bg-[#252631]'}`}>{t('drink')}</button>
            </div>
            <LanguageToggle includeOromia={false} />
            <Link href="/manager/reports" className={BTN_SECONDARY}>
              {t('managerReports')}
            </Link>
            <Link href="/menu" target="_blank" className={BTN_PRIMARY}>
              {t('viewMenu')}
            </Link>
            <Link href="/waiter" target="_blank" className={BTN_SECONDARY}>
              {t('viewWaiter')}
            </Link>
            <div className="flex items-center gap-2">
              <ThemeToggleHome />
              <Link
                href="/"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner hover:bg-[#F8FAFC] dark:hover:bg-[#252631]"
                title={t('home')}
                aria-label={t('home')}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" />
                </svg>
              </Link>
            </div>
          </div>
        </div>
        {/* MOBILE */}
        <div className="flex flex-col gap-2 md:hidden" ref={mobileNavRef}>
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-base font-extrabold text-[#1E293B] dark:text-white">
              {t('menuManagement')}
            </h1>
            <div className="flex items-center gap-2">
              <LanguageToggle includeOromia={false} />
              <ThemeToggleHome />
              <button
                type="button"
                onClick={() => setMobileNavOpen((v) => !v)}
                aria-label={mobileNavOpen ? t('navCloseMenu') : t('navOpenMenu')}
                aria-expanded={mobileNavOpen}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out active:shadow-inner"
              >
                {mobileNavOpen ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          <div className="flex items-center justify-center gap-1 rounded-full bg-[#F4F5F9] dark:bg-[#12131A] p-1 border border-[#E2E8F0]/60 dark:border-[#2A2B36] self-center">
            <button type="button" onClick={() => handleTabChange('KITCHEN')} className={`px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wide transition-all ${activeTab === 'KITCHEN' ? 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-sm' : 'bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white/80 border border-[#E2E8F0]/60 dark:border-[#2A2B36]'}`}>{t('food')}</button>
            <button type="button" onClick={() => handleTabChange('BARISTA')} className={`px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wide transition-all ${activeTab === 'BARISTA' ? 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-sm' : 'bg-white dark:bg-[#1C1D24] text-[#1E293B] dark:text-white/80 border border-[#E2E8F0]/60 dark:border-[#2A2B36]'}`}>{t('drink')}</button>
          </div>
          {mobileNavOpen && (
            <div className="absolute left-2 right-2 top-full z-40 mt-2 rounded-2xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-[0_12px_30px_rgba(0,0,0,0.15)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] p-2 space-y-1 max-w-[calc(100vw-1rem)]">
              <Link href="/manager/reports" onClick={() => setMobileNavOpen(false)} className="flex h-10 items-center rounded-xl px-3 text-xs font-bold uppercase tracking-wide text-[#1E293B] dark:text-white hover:bg-[#F4F5F9] dark:hover:bg-[#252631] transition-colors">
                {t('managerReports')}
              </Link>
              <Link href="/menu" target="_blank" onClick={() => setMobileNavOpen(false)} className="flex h-10 items-center rounded-xl px-3 text-xs font-bold uppercase tracking-wide text-[#1E293B] dark:text-white hover:bg-[#F4F5F9] dark:hover:bg-[#252631] transition-colors">
                {t('viewMenu')}
              </Link>
              <Link href="/waiter" target="_blank" onClick={() => setMobileNavOpen(false)} className="flex h-10 items-center rounded-xl px-3 text-xs font-bold uppercase tracking-wide text-[#1E293B] dark:text-white hover:bg-[#F4F5F9] dark:hover:bg-[#252631] transition-colors">
                {t('viewWaiter')}
              </Link>
            </div>
          )}
        </div>
      </header>

      {/* Stats — filtered by active tab */}
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className={CARD + ' p-4'}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">{t('statCategories')}</p>
          <p className="mt-2 text-2xl font-extrabold text-[#1E293B] dark:text-white">{filteredCategories.length}</p>
        </div>
        <div className={CARD + ' p-4'}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">{t('statMenuItems')}</p>
          <p className="mt-2 text-2xl font-extrabold text-[#1E293B] dark:text-white">{filteredItems.length}</p>
        </div>
        <div className={CARD + ' p-4'}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">{t('available')}</p>
          <p className="mt-2 text-2xl font-extrabold text-[#1E293B] dark:text-white">{filteredItems.filter(i => i.isAvailable).length}</p>
        </div>
        <div className={CARD + ' p-4'}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">{t('special')}</p>
          <p className="mt-2 text-2xl font-extrabold text-[#1E293B] dark:text-white">{filteredItems.filter(i => i.isSpecial).length}</p>
        </div>
      </div>

      {/* Category Manager — filtered by Foods/Drinks tab */}
      <section className={`${CARD} mt-4 p-4 sm:p-5`}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-extrabold text-[#1E293B] dark:text-white flex items-center gap-2">
            {t('categories')}
            <span className="ml-1 rounded-full bg-[#F4F5F9] dark:bg-[#252631] px-2 py-0.5 text-xs font-bold text-[#64748B] dark:text-[#94A3B8]">{filteredCategories.length}</span>
          </h2>
          <button type="button" onClick={() => setShowCategoryManager(v => !v)} className={showCategoryManager ? BTN_SECONDARY + ' !h-9' : BTN_PRIMARY + ' !h-9'}>
            {showCategoryManager ? t('hide') : t('manage')}
          </button>
        </div>

        {showCategoryManager && (
          <div className="mt-4 space-y-4">
            <form onSubmit={handleCreateCategory} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label className="block text-xs font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8] mb-1.5">{t('newCategoryName')}</label>
                <input value={catName} onChange={e => setCatName(e.target.value)} placeholder="e.g. Special Food, Hot Drinks" className="w-full rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-4 py-3 text-sm text-[#1E293B] dark:text-white placeholder:text-[#64748B]/60 dark:placeholder:text-[#94A3B8]/60 focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40" />
              </div>
              <button disabled={isPending} type="submit" className={BTN_PRIMARY + ' justify-center disabled:opacity-50'}>{t('addCategory')}</button>
            </form>
            {catError && <p className="rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 px-3 py-2 text-sm font-semibold text-red-600 dark:text-red-300">{catError}</p>}
            {catSuccess && <p className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 px-3 py-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">{catSuccess}</p>}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {filteredCategories.map(cat => (
                <div key={String(cat._id)} className="flex items-center justify-between gap-2 rounded-xl bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-[#1E293B] dark:text-white">{cat.name}</p>
                    <p className="truncate text-xs text-[#64748B] dark:text-[#94A3B8]">{cat.slug} • {cat.type}</p>
                  </div>
                   <button type="button" onClick={() => handleDeleteCategory(String(cat._id), cat.name)} className="shrink-0 rounded-full bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-1.5 text-xs font-bold text-[#64748B] dark:text-[#94A3B8] hover:text-red-600 dark:hover:text-red-400 hover:border-red-200 dark:hover:border-red-900 transition">{t('delete')}</button>
                </div>
              ))}
              {filteredCategories.length === 0 && <p className="text-sm text-[#64748B] dark:text-[#94A3B8] col-span-full">{t('noCategories')}</p>}
            </div>
          </div>
        )}

        {!showCategoryManager && (
          <div className="mt-3 flex flex-wrap gap-2">
            {filteredCategories.slice(0, 8).map(cat => (
              <span key={String(cat._id)} className="rounded-full bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-1 text-xs font-semibold text-[#64748B] dark:text-[#94A3B8]">{cat.name}</span>
            ))}
            {filteredCategories.length > 8 && <span className="rounded-full bg-[#FFD600]/15 dark:bg-[#FF5E00]/15 border border-[#FFD600]/20 dark:border-[#FF5E00]/20 px-3 py-1 text-xs font-bold text-[#8A6D00] dark:text-[#FF8A3D]">+{filteredCategories.length - 8} more</span>}
          </div>
        )}
      </section>

      {/* CREATE — page-level form entry. While EDITING an item this hides and the
          same form instance renders inline at that item's row/card instead. */}
      {!editingId && (
        <section className={`${CARD} mt-4 p-4 sm:p-5`}>
          <div className="mb-5">
            <h2 className="text-lg font-extrabold text-[#1E293B] dark:text-white">{t('createMenuBtn')}</h2>
          </div>
          {itemForm}
        </section>
      )}

      {/* PAYMENT INFORMATION MANAGER */}
      <section className={`${CARD} mt-4 p-4 sm:p-5`}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-extrabold text-[#1E293B] dark:text-white flex items-center gap-2">
            {t('paymentInformation')}
            <span className="ml-1 rounded-full bg-[#F4F5F9] dark:bg-[#252631] px-2 py-0.5 text-xs font-bold text-[#64748B] dark:text-[#94A3B8]">{paymentInfos.length}</span>
          </h2>
          <button type="button" onClick={() => setShowPaymentManager(v => !v)} className={showPaymentManager ? BTN_SECONDARY + ' !h-9' : BTN_PRIMARY + ' !h-9'}>
            {showPaymentManager ? t('hide') : t('manage')}
          </button>
        </div>

        {showPaymentManager && (
          <div className="mt-4 space-y-4">
            <form onSubmit={editingPayId ? handleUpdatePayment : handleCreatePayment} className="rounded-xl bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] p-4 space-y-3">
              <p className="text-xs font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8] mb-1">
                {editingPayId ? t('editBankDetail') : t('addBankDetail')}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-bold text-[#64748B] dark:text-[#94A3B8] mb-1">{t('bankName')} *</label>
                  <input value={payForm.bankName} onChange={e => setPayForm(f => ({ ...f, bankName: e.target.value }))} placeholder="e.g. Commercial Bank of Ethiopia" className="w-full rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-2.5 text-sm text-[#1E293B] dark:text-white placeholder:text-[#64748B]/60 dark:placeholder:text-[#94A3B8]/60 focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#64748B] dark:text-[#94A3B8] mb-1">{t('ownerName')} *</label>
                  <input value={payForm.ownerName} onChange={e => setPayForm(f => ({ ...f, ownerName: e.target.value }))} placeholder="e.g. I Hope Cafe" className="w-full rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-2.5 text-sm text-[#1E293B] dark:text-white placeholder:text-[#64748B]/60 dark:placeholder:text-[#94A3B8]/60 focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#64748B] dark:text-[#94A3B8] mb-1">{t('accountNumber')} *</label>
                  <input value={payForm.accountNumber} onChange={e => setPayForm(f => ({ ...f, accountNumber: e.target.value }))} placeholder="e.g. 1000123456789" className="w-full rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-2.5 text-sm font-bold text-[#1E293B] dark:text-white placeholder:text-[#64748B]/60 dark:placeholder:text-[#94A3B8]/60 focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40" />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <TogglePill checked={payForm.isActive} onChange={v => setPayForm(f => ({ ...f, isActive: v }))} label={t('active')} />
                <div className="flex gap-2 ml-auto">
                  {editingPayId && (
                    <button type="button" onClick={() => { setEditingPayId(null); setPayForm({ bankName: '', ownerName: '', accountNumber: '', isActive: true }); setPayError(''); setPaySuccess(''); }} className={BTN_SECONDARY + ' !h-9'}>{t('cancel')}</button>
                  )}
                  <button type="submit" disabled={payLoading} className={BTN_PRIMARY + ' !h-9 justify-center disabled:opacity-50'}>
                    {payLoading ? t('saving') : editingPayId ? t('update') : t('addBank')}
                  </button>
                </div>
              </div>
              {payError && <p className="rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 px-3 py-2 text-sm font-semibold text-red-600 dark:text-red-300">{payError}</p>}
              {paySuccess && <p className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 px-3 py-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">{paySuccess}</p>}
            </form>

            <div className="grid grid-cols-1 gap-2">
              {paymentInfos.map(p => (
                <div key={String(p._id)} className="flex flex-col gap-2 rounded-xl bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-bold text-[#1E293B] dark:text-white">{p.bankName}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold border ${p.isActive ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300' : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-600 dark:text-red-300'}`}>{p.isActive ? t('active') : t('inactive')}</span>
                    </div>
                    <p className="truncate text-xs text-[#64748B] dark:text-[#94A3B8]">{p.ownerName} • {p.accountNumber}</p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <button type="button" onClick={() => handleEditPayment(p)} className="rounded-full bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white px-3 py-1.5 text-xs font-bold border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-sm hover:brightness-105 transition">{t('edit')}</button>
                    <button type="button" onClick={() => handleDeletePayment(p)} className="rounded-full bg-white dark:bg-[#1C1D24] border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 px-3 py-1.5 text-xs font-bold hover:bg-red-50 dark:hover:bg-red-950/30 transition">{t('delete')}</button>
                  </div>
                </div>
              ))}
              {paymentInfos.length === 0 && <p className="text-sm text-[#64748B] dark:text-[#94A3B8]">{t('noPaymentInfo')}</p>}
            </div>
          </div>
        )}
      </section>

      {/* HOTEL BRANDING SETTINGS */}
      <section className={`${CARD} mt-4 p-4 sm:p-5`}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-extrabold text-[#1E293B] dark:text-white flex items-center gap-2">
            {t('brandingSettings')}
          </h2>
          <button type="button" onClick={() => setShowBrandingManager(v => !v)} className={showBrandingManager ? BTN_SECONDARY + ' !h-9' : BTN_PRIMARY + ' !h-9'}>
            {showBrandingManager ? t('hide') : t('manage')}
          </button>
        </div>

        {showBrandingManager && (
          <div className="mt-4 space-y-4">
            <form onSubmit={handleSaveBranding} className="rounded-xl bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] p-4 space-y-3">
              <p className="text-xs font-bold uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8] mb-1">
                {t('updateBrand')}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-bold text-[#64748B] dark:text-[#94A3B8] mb-1">{t('brandName')} *</label>
                  <input value={brandForm.name} onChange={e => setBrandForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. I Hope Cafe" className="w-full rounded-xl bg-white dark:bg-[#1C1D24] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-3 py-2.5 text-sm text-[#1E293B] dark:text-white placeholder:text-[#64748B]/60 dark:placeholder:text-[#94A3B8]/60 focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#64748B] dark:text-[#94A3B8] mb-1">{t('chooseLocalDevice')}</label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    onChange={handleLogoFileChange}
                    className="w-full cursor-pointer rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] px-3 py-2.5 text-sm text-[#1E293B] dark:text-white file:mr-3 file:rounded-full file:border-0 file:bg-[#FFD600] dark:file:bg-[#FF5E00] file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-[#1E293B] dark:file:text-white hover:file:opacity-90 focus:outline-none focus:ring-2 focus:ring-[#FFD600]/40 dark:focus:ring-[#FF5E00]/40"
                  />
                </div>
              </div>

              {(logoPreview || brandForm.logoPath) && (
                <div className="relative h-20 w-20 overflow-hidden rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#12131A]">
                  <img src={logoPreview || brandForm.logoPath} alt="Logo preview" className="h-full w-full object-contain" />
                </div>
              )}

              <div className="flex gap-2 ml-auto">
                  <button type="submit" disabled={brandLoading} className={BTN_PRIMARY + ' !h-9 justify-center disabled:opacity-50'}>
                    {brandLoading ? t('saving') : t('saveBranding')}
                  </button>
              </div>
              {brandError && <p className="rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 px-3 py-2 text-sm font-semibold text-red-600 dark:text-red-300">{brandError}</p>}
              {brandSuccess && <p className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 px-3 py-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">{brandSuccess}</p>}
            </form>
          </div>
        )}
      </section>


      {/* Data Table — existing items (filtered by Foods/Drinks) */}
      <section className={`${CARD} mt-4 overflow-hidden`}>
        <div className="px-5 py-4 sm:px-6 flex items-center justify-between gap-3 border-b border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9]/50 dark:bg-[#252631]/50">
          <h3 className="text-sm font-extrabold uppercase tracking-widest text-[#1E293B] dark:text-white">{t('menuItemsTitle')} • {filteredItems.length}</h3>
        </div>

        {/* Fasting / Non-Fasting filter — uses existing per-item dietary fields */}
        <div className="flex flex-wrap gap-2 px-5 py-3 sm:px-6 border-b border-[#E2E8F0]/60 dark:border-[#2A2B36]">
          {[
            { key: 'all', label: t('all') },
            { key: 'fasting', label: t('fasting') },
            { key: 'nonFasting', label: t('nonFasting') },
          ].map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setDietFilter(opt.key)}
              className={`rounded-full px-4 py-1.5 text-xs font-bold transition-all ${
                dietFilter === opt.key
                  ? 'bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white'
                  : 'bg-[#F4F5F9] dark:bg-[#252631] text-[#64748B] dark:text-[#94A3B8] hover:brightness-105'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {filteredItems.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-4xl mb-3">🍽️</p>
            <p className="text-sm font-bold text-[#1E293B] dark:text-white">{t('noMenuItems')}</p>
            <p className="text-xs text-[#64748B] dark:text-[#94A3B8]">{t('createFirstItem')}</p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-[#F4F5F9] dark:bg-[#252631] text-[11px] uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">
                  <tr>
                    <th className="px-4 py-3">{t('colImage')}</th>
                    <th className="px-4 py-3">{t('colName')}</th>
                    <th className="px-4 py-3">{t('category')}</th>
                    <th className="px-4 py-3">{t('colPrice')}</th>
                    <th className="px-4 py-3">{t('colFlags')}</th>
                    <th className="px-4 py-3 text-right">{t('colActions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0]/60 dark:divide-[#2A2B36]">
                  {sortedItems.map(item => {
                    const isEditingThis = String(editingId) === String(item._id);
                    return (
                      <Fragment key={String(item._id)}>
                        <tr className="hover:bg-[#F4F5F9]/60 dark:hover:bg-[#252631]/60 transition">
                      <td className="px-4 py-3">
                        <div className="h-12 w-12 overflow-hidden rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A] shrink-0">
                          {item.imageUrl ? <img src={item.imageUrl} alt="" className="h-full w-full object-cover" /> : <div className="h-full w-full flex items-center justify-center text-[10px] text-[#64748B] dark:text-[#94A3B8]">{t('noImage')}</div>}
                        </div>
                      </td>
                      <td className="px-4 py-3 min-w-[200px]">
                        <p className="font-bold text-[#1E293B] dark:text-white">{item.nameEn || item.name?.en}</p>
                        <p className="text-xs text-[#64748B] dark:text-[#94A3B8]">{item.nameAm || item.name?.am} {item.nameOm ? `• ${item.nameOm}` : ''}</p>
                        <p className="mt-1 line-clamp-1 text-xs text-[#64748B] dark:text-[#94A3B8]">{item.descriptionEn || item.description?.en || ''}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex rounded-full bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-2.5 py-1 text-xs font-bold text-[#64748B] dark:text-[#94A3B8]">{item.categoryName || '—'}</span>
                      </td>
                      <td className="px-4 py-3 font-black text-[#1E293B] dark:text-white">ETB {Number(item.price).toLocaleString()}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1 max-w-[180px]">
                          {item.isSpecial && <span className="rounded-full bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white px-2 py-0.5 text-[10px] font-bold border border-[#E2E8F0]/60 dark:border-[#2A2B36]">{t('special')}</span>}
                          {item.isNew && <span className="rounded-full bg-[#FFD600]/15 dark:bg-[#FF5E00]/15 border border-[#FFD600]/20 dark:border-[#FF5E00]/20 text-[#8A6D00] dark:text-[#FF8A3D] px-2 py-0.5 text-[10px] font-bold">{t('new')}</span>}
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold border ${item.isAvailable ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300' : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-600 dark:text-red-300'}`}>{item.isAvailable ? t('available') : t('hidden')}</span>
                          {item.isFasting && <span className="rounded-full bg-emerald-500 text-white px-2 py-0.5 text-[10px] font-bold">{t('fasting')}</span>}
                          {item.isNonFasting && <span className="rounded-full bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] text-[#64748B] dark:text-[#94A3B8] px-2 py-0.5 text-[10px] font-bold">{t('nonFShort')}</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex gap-1.5">
                          <button onClick={() => handleEditItem(item)} className="rounded-full bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white px-3 py-1.5 text-xs font-bold border border-[#E2E8F0]/60 dark:border-[#2A2B36] shadow-sm hover:brightness-105 transition">{t('edit')}</button>
                          <button onClick={() => handleDelete(item)} className="rounded-full bg-white dark:bg-[#1C1D24] border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 px-3 py-1.5 text-xs font-bold hover:bg-red-50 dark:hover:bg-red-950/30 transition">{t('delete')}</button>
                        </div>
                      </td>
                    </tr>
                    {isEditingThis && (
                      <tr>
                        <td colSpan={6} className="bg-[#F4F5F9]/60 dark:bg-[#252631]/60 px-4 py-4">
                          {itemForm}
                        </td>
                      </tr>
                    )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-[#E2E8F0]/60 dark:divide-[#2A2B36]">
              {sortedItems.map(item => {
                const isEditingThis = String(editingId) === String(item._id);
                return (
                  <div key={String(item._id)} className="p-4">
                    <div className="flex gap-3">
                      <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-[#F4F5F9] dark:bg-[#12131A]">
                    {item.imageUrl ? <img src={item.imageUrl} alt="" className="h-full w-full object-cover" /> : <div className="h-full w-full flex items-center justify-center text-xs text-[#64748B] dark:text-[#94A3B8]">{t('noImage')}</div>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-[#1E293B] dark:text-white truncate">{item.nameEn}</p>
                    <p className="text-xs text-[#64748B] dark:text-[#94A3B8] truncate">{item.nameAm}</p>
                    <p className="mt-1 text-xs text-[#64748B] dark:text-[#94A3B8] line-clamp-1">{item.descriptionEn}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-black text-[#1E293B] dark:text-white">ETB {Number(item.price).toLocaleString()}</span>
                      <span className="rounded-full bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] px-2 py-0.5 text-[10px] text-[#64748B] dark:text-[#94A3B8]">{item.categoryName}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {item.isSpecial && <span className="rounded-full bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white px-1.5 py-0.5 text-[10px] font-bold">S</span>}
                      {item.isNew && <span className="rounded-full bg-[#FFD600]/15 dark:bg-[#FF5E00]/15 border border-[#FFD600]/20 dark:border-[#FF5E00]/20 text-[#8A6D00] dark:text-[#FF8A3D] px-1.5 py-0.5 text-[10px] font-bold">N</span>}
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold border ${item.isAvailable ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300' : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-600 dark:text-red-300'}`}>{item.isAvailable ? 'Av' : 'Hi'}</span>
                      {item.isFasting && <span className="rounded-full bg-emerald-500 text-white px-1.5 py-0.5 text-[10px]">F</span>}
                      {item.isNonFasting && <span className="rounded-full bg-[#F4F5F9] dark:bg-[#252631] border border-[#E2E8F0]/60 dark:border-[#2A2B36] text-[#64748B] dark:text-[#94A3B8] px-1.5 py-0.5 text-[10px]">NF</span>}
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button onClick={() => handleEditItem(item)} className="flex-1 rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-[#1E293B] dark:text-white py-2 text-xs font-bold border border-[#E2E8F0]/60 dark:border-[#2A2B36]">{t('edit')}</button>
                      <button onClick={() => handleDelete(item)} className="flex-1 rounded-xl bg-white dark:bg-[#1C1D24] border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 py-2 text-xs font-bold">{t('delete')}</button>
                    </div>
                    </div>
                    </div>
                    {isEditingThis && (
                      <div className="mt-3 border-t border-[#E2E8F0]/60 dark:border-[#2A2B36] pt-3">
                        {itemForm}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="px-5 py-3 bg-[#F4F5F9]/50 dark:bg-[#252631]/50 border-t border-[#E2E8F0]/60 dark:border-[#2A2B36] text-center text-xs text-[#64748B] dark:text-[#94A3B8]">
          {t('instantSync')}
        </div>
      </section>
    </div>
  );
}
