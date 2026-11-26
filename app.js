/* AddaBook — single-file app (Supabase backend) */
const SUPABASE_URL = 'https://eowrjgdvdntnpgyamuxl.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvd3JqZ2R2ZG50bnBneWFtdXhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU2MjkzMjQsImV4cCI6MjExMTIwNTMyNH0.Zl_dnGYGtJneH8x8cHbnY7TIX40QKYyS6XIAJK_CuDI';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

let me = null;            // my profile row
let curView = 'feed';
let profilesCache = {};   // id -> profile
let pagesCache = {};      // id -> page
let friendIds = new Set();
let followIds = new Set();
let blockedIds = new Set();
let closeOfIds = new Set();   // authors who added ME as close friend
let myCloseIds = new Set();   // people I added as close friends
let unreadNotifs = 0;
let activeChat = null;    // conversation id open
let chatChannel = null;
let notifChannel = null;
/* ---------- CHAT PACK state ---------- */
let onlineIds = new Set();        // presence: user ids online right now
let presenceChannel = null;
let typingChannel = null;         // per-conversation typing broadcast channel
let typingTopic = '';
let typingClearTimer = null;
let typingHideTimer = null;
let lastTypingAt = 0;
let replyTarget = null;           // message object being replied to
let chatMeta = { conv: null, members: [], myRow: null, otherRow: null };
let chatMsgs = [];                // messages of the open conversation, oldest first
let chatMsgMap = {};              // id -> message (quote lookups)
let chatReactions = {};          // message_id -> { emoji: {count, mine} }
/* ---------- CHAT PACK 2 state ---------- */
let chatPollVotes = {};          // message_id -> { counts: {choiceIdx: n}, mine: choiceIdx|null, total }
let chatListMode = 'main';       // chat list filter: 'main' | 'archived' | 'restricted'
const POLL_PREFIX = '\u{1F5F3}POLL:';
function pollOf(m){
  if (!m || !m.body || !m.body.startsWith(POLL_PREFIX)) return null;
  try { const p = JSON.parse(m.body.slice(POLL_PREFIX.length)); return (p && p.q && Array.isArray(p.options) && p.options.length >= 2) ? p : null; } catch (e) { return null; }
}
/* media detection for chat memories: voice notes, file attachments, bare image URLs */
function chatMediaOf(m){
  const b = (m && m.body) || '';
  if (b.startsWith('🎧AUDIO:')) return { type: 'audio', url: b.slice(8) };
  if (b.startsWith('📎FILE:')) {
    const rest = b.slice(7); const i = rest.indexOf('|');
    const url = i >= 0 ? rest.slice(0, i) : rest; const name = i >= 0 ? rest.slice(i + 1) : '';
    const isImg = /\.(jpe?g|png|webp|gif)$/i.test(name) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);
    return isImg ? { type: 'image', url, name } : { type: 'file', url, name };
  }
  if (/^https?:\/\/\S+\.(jpe?g|png|webp|gif)(\?\S*)?$/i.test(b)) return { type: 'image', url: b };
  return null;
}
/* 12 chat themes: [key, color1, color2, Bangla label]. Bubble gradient = c1->c2 (white text stays
   readable in light + dark); the chat area gets a soft tint from the same pair. */
const CHAT_THEMES = [
  ['beguni',   '#7C3AED', '#4F46E5', 'বেগুনি'],
  ['nil',      '#2563EB', '#0891B2', 'নীল'],
  ['shobuj',   '#059669', '#16A34A', 'সবুজ'],
  ['golapi',   '#DB2777', '#F43F5E', 'গোলাপি'],
  ['komola',   '#EA580C', '#D97706', 'কমলা'],
  ['lal',      '#DC2626', '#B91C1C', 'লাল'],
  ['teal',     '#0D9488', '#0E7490', 'টিল'],
  ['dhushor',  '#64748B', '#475569', 'ধূসর-নীল'],
  ['golden',   '#CA8A04', '#A16207', 'গোল্ডেন'],
  ['garhonil', '#1D4ED8', '#1E3A8A', 'গাঢ় নীল'],
  ['mint',     '#0CA678', '#099268', 'মিন্ট'],
  ['peach',    '#F0764F', '#E14E63', 'পিচ']
];
function chatTheme(key){ return CHAT_THEMES.find(t => t[0] === key) || null; }
/* language-aware label for strings rendered INSIDE .msg bubbles (the i18n DOM pass skips .msg) */
const tx = (b, e) => LANG === 'en' ? e : b;

const $ = s => document.querySelector(s);
const view = () => $('#view');
/* ---------- LANGUAGE: saved pref wins, else auto-detect from the device/browser.
   'bn' rendering is the original behaviour; 'en' layers on top via the I18N pass below. */
let LANG = (() => { const s = localStorage.getItem('adda-lang'); if (s === 'bn' || s === 'en') return s; return (navigator.language || '').toLowerCase().startsWith('bn') ? 'bn' : 'en'; })();
const BN = '০১২৩৪৫৬৭৮৯';
const bn = n => LANG === 'en' ? String(n) : String(n).replace(/[0-9]/g, d => BN[d]);
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const COLORS = ['#4F46E5','#2563EB','#DB2777','#059669','#D97706','#7C3AED','#0891B2','#DC2626'];
function colorFor(id){ let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
function safeUrl(u){ return u && /^https?:\/\/[^\s'")]+$/.test(u) ? u : ''; }
function avatar(p, size = 38, fs = 15){
  if (p && p.avatar_url) return `<img class="avimg" src="${esc(p.avatar_url)}" style="width:${size}px;height:${size}px" alt="">`;
  const name = (p && p.name) || '?';
  return `<span class="av" style="background:${colorFor(p ? p.id : name)};width:${size}px;height:${size}px;font-size:${fs}px">${esc(name.trim()[0] || '?')}</span>`;
}
const CROWN = '<svg viewBox="0 0 24 24" width="10" height="10" fill="#fff" aria-hidden="true"><path d="M3 17.5 2 7l5.2 3.6L12 5l4.8 5.6L22 7l-1 10.5z"/><rect x="3" y="18.6" width="18" height="1.9" rx="0.95"/></svg>';
function badges(p){ return (p && p.verified ? '<span class="vf">✓</span>' : '') + (p && p.badge ? `<span class="gold" title="Premium">${CROWN}</span>` : ''); }
function timeAgo(ts){
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (LANG === 'en'){
    if (s < 60) return 'Just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
    if (s < 86400 * 30){ const d = Math.floor(s / 86400); return d + (d === 1 ? ' day ago' : ' days ago'); }
    return new Date(ts).toLocaleDateString('en-US');
  }
  if (s < 60) return 'এখনই';
  if (s < 3600) return bn(Math.floor(s / 60)) + ' মিনিট আগে';
  if (s < 86400) return bn(Math.floor(s / 3600)) + ' ঘণ্টা আগে';
  if (s < 86400 * 30) return bn(Math.floor(s / 86400)) + ' দিন আগে';
  return new Date(ts).toLocaleDateString('bn-BD');
}
function toast(msg){
  const old = document.querySelector('.toast'); if (old) old.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}
function sheet(html){
  $('#overlay').innerHTML = `<div class="sheet" onclick="if(event.target===this)closeSheet()"><div class="sheetbox"><button onclick="closeSheet()" aria-label="বন্ধ করো" style="float:right;border:none;background:var(--line2);color:var(--ink2);width:30px;height:30px;border-radius:50%;font-size:15px;cursor:pointer;line-height:1">${ic('x', 14)}</button>${html}</div></div>`;
}
function closeSheet(){ $('#overlay').innerHTML = ''; }
function linkTags(text){
  return esc(text).replace(/#([\p{L}\p{N}_]+)/gu, '<a class="tag" href="#" onclick="openTag(\'$1\');return false">#$1</a>');
}
async function notify(userId, type, postId = null, convId = null){
  if (!me || userId === me.id) return;
  await sb.from('notifications').insert({ user_id: userId, actor_id: me.id, type, post_id: postId, conversation_id: convId });
}
async function cacheProfiles(ids){
  const missing = [...new Set(ids)].filter(id => id && !profilesCache[id]);
  if (!missing.length) return;
  const { data } = await sb.from('profiles').select('*').in('id', missing);
  (data || []).forEach(p => profilesCache[p.id] = p);
}
function prof(id){ return profilesCache[id] || { id, name: 'ব্যবহারকারী', avatar_url: '' }; }

/* ================= I18N: English UI layer (active only when LANG === 'en') =================
   How it works: the app always renders Bangla strings. In English mode a DOM pass
   translates text nodes + placeholder/aria-label/title attributes using the exact-match
   dictionary below, then anchored patterns (composed strings), then distinctive fragments.
   User content is never touched: post bodies (.ptext), chat bubbles (.msg) and comment
   bodies are skipped, stored values are never read from the DOM, and <option> elements
   keep their original Bangla value attribute so form submissions stay identical. */
const I18N = {
  'সেবা বোর্ড': 'Service board', 'বাজার': 'Market', 'ইভেন্ট': 'Events', 'ভিডিও যোগ করো': 'Add video',
  'কোলাজ বানাও (২-৪টি ছবি)': 'Make a collage (2-4 photos)', 'পোল যোগ করো': 'Add a poll',
  'সবাই দেখবে': 'Everyone can see', 'শুধু বন্ধুরা': 'Friends only', 'লিংক কপি': 'Copy link',
  'কে দেখল': 'Who viewed', 'উপহার (১০০)': 'Gift (100)', 'বেনামে প্রশ্ন': 'Ask anonymously',
  'পোস্ট এডিট করো': 'Edit post', 'পিন সরাও': 'Unpin', 'প্রোফাইলে পিন করো': 'Pin to profile',
  'আর্কাইভ থেকে ফেরাও': 'Restore from archive', 'আর্কাইভ করো': 'Archive',
  'পোস্ট পড়ে শোনাও': 'Read post aloud', 'ইংরেজিতে অনুবাদ': 'Translate to English',
  'বুস্ট করো (৫০ টোকেন, ২৪ ঘণ্টা)': 'Boost (50 tokens, 24 hours)',
  'এই পোস্ট বুস্ট অবস্থায় আছে': 'This post is boosted', 'পোস্ট মুছে ফেলো': 'Delete post',
  'রিপোর্ট করো': 'Report', 'এই ব্যবহারকারীকে ব্লক করো': 'Block this user',
  'রক্ত': 'Blood', 'হারানো-প্রাপ্তি': 'Lost & found', 'চাকরি': 'Jobs',
  'রক্তের আবেদন': 'Blood request', 'চাকরির পোস্ট': 'Job post', 'নতুন বিজ্ঞাপন': 'New listing',
  'সরকারি সেবার লিংক': 'Government service links', 'পড়াশোনা কর্নার': 'Study corner',
  'রেসিপি কর্নার': 'Recipe corner', 'ভ্রমণ কর্নার': 'Travel corner',
  'ছবির অ্যালবাম': 'Photo albums', 'আমার অ্যালবাম': 'My albums', 'টোকেন ওয়ালেট': 'Token wallet',
  'লগইন স্ট্রিক': 'Login streak', 'আর্কাইভ করা পোস্ট': 'Archived posts',
  'প্রোফাইল দর্শক': 'Profile viewers', 'বেনামি প্রশ্নের ইনবক্স': 'Anonymous question inbox',
  'আমার ডেটা ডাউনলোড': 'Download my data', 'ক্রিয়েটর ড্যাশবোর্ড': 'Creator dashboard',
  'আড্ডা বাজার': 'Adda Market', 'সেবা বোর্ড (রক্ত · হারানো · চাকরি)': 'Service board (blood · lost · jobs)',
  'সরকারি সেবা ও কর্নার': 'Government services & corners', 'পাসওয়ার্ড বদলাও': 'Change password',
  'নতুন পোস্ট কে দেখবে (ডিফল্ট)': 'Who sees new posts (default)', 'ব্লক করা মানুষ': 'Blocked people',
  'আড্ডাBook সম্পর্কে': 'About AddaBook', 'সব ডিভাইস থেকে লগ আউট': 'Log out from all devices',
  'ডার্ক / লাইট থিম': 'Dark / light theme', 'সহজ মোড (বড় লেখা)': 'Easy mode (big text)',
  'ডেটা সেভার মোড (ছবি চাপ দিলে লোড)': 'Data saver mode (tap to load photos)',
  'কিড মোড (ডেটিং লুকানো)': 'Kid mode (dating hidden)', 'লগ আউট': 'Log out',
  'করা যায়নি': 'Could not be done', 'বদলানো যায়নি': 'Could not be changed', 'মোছা যায়নি': 'Could not be deleted', 'থিম বদলানো যায়নি': 'Could not change the theme', 'ডাকনাম দেওয়া যায়নি': 'Could not set nickname', 'ফাইল ১০MB-এর বেশি হতে পারবে না': 'File cannot be larger than 10MB', '(তুমি)': '(You)',
  'নতুন পোস্ট কে দেখবে?': 'Who can see new posts?', 'সম্পর্কের অবস্থা (ঐচ্ছিক)': 'Relationship status (optional)',
  'লিঙ্গ (ঐচ্ছিক)': 'Gender (optional)', 'ছবি দেখো (ডেটা সেভার)': 'View photo (data saver)',
  'ভয়েস': 'Voice', 'নতুন স্টোরি (২৪ ঘণ্টা থাকবে)': 'New story (stays for 24 hours)',
  'রিপ্লাই দাও': 'Reply', 'এই দিনে': 'On this day', 'গ্রুপ তহবিল': 'Group fund',
  'সাপ্তাহিক রিপোর্ট (গত ৭ দিন)': 'Weekly report (last 7 days)', 'তোমার সেরা পোস্ট': 'Your best post',
  'বেনামে প্রশ্ন করো': 'Ask a question anonymously', 'ব্লক করো': 'Block',
  'এই প্রোফাইল রিপোর্ট করো': 'Report this profile', 'আজকের কুইজ': "Today's quiz",
  'লিডারবোর্ড (টোকেন)': 'Leaderboard (tokens)', 'তোমার অর্জন': 'Your achievements',
  'জন্মদিন': 'Birthday', 'কাজ / পেশা (যেমন: ছাত্র, শিক্ষক)': 'Work / profession (e.g. student, teacher)',
  'পড়াশোনা (যেমন: ঢাকা বিশ্ববিদ্যালয়)': 'Education (e.g. University of Dhaka)',
  'নিজ শহর (যেমন: রাজশাহী)': 'Hometown (e.g. Rajshahi)', 'ডাকনাম (যেমন: লিমন)': 'Nickname (e.g. Limon)',
  'ভাষা (যেমন: বাংলা, English)': 'Languages (e.g. Bangla, English)',
  'ওয়েবসাইট (যেমন: example.com)': 'Website (e.g. example.com)',
  'শখ (যেমন: বই পড়া, ফুটবল, গান)': 'Hobbies (e.g. reading, football, music)',
  'পছন্দের উক্তি': 'Favorite quote', 'পোষা প্রাণীর প্রোফাইল': 'Pet profiles',
  'পোষা প্রাণী': 'Pet', 'অভ্যাস ট্র্যাকার': 'Habit tracker',
  /* shell / nav / auth */
  'হোম': 'Home', 'বন্ধু': 'Friend', 'চ্যাট': 'Chat', 'প্রোফাইল': 'Profile', 'আবিষ্কার': 'Explore',
  'খোঁজো': 'Search', 'নোটিফিকেশন': 'Notifications', 'স্টিকার': 'Stickers', 'ভয়েস মেসেজ': 'Voice message',
  /* chat pack */
  'মেসেজ অপশন': 'Message options', 'রিপ্লাই': 'Reply', 'কপি': 'Copy', 'কপি হয়েছে': 'Copied',
  'সম্পাদনা': 'Edit', 'মেসেজ সম্পাদনা': 'Edit message', 'সেভ করো': 'Save', 'সবার জন্য মোছো': 'Delete for everyone',
  'মেসেজ মোছা হয়েছে': 'Message deleted', 'চ্যাটের তথ্য': 'Chat info', 'ডাকনাম দাও': 'Set nickname', 'ডাকনাম': 'Nickname',
  'চ্যাটের থিম': 'Chat theme', 'পিন করো': 'Pin chat', 'মিউট': 'Mute', 'আনমিউট': 'Unmute', 'ডিফল্ট': 'Default',
  'ডিসঅ্যাপিয়ারিং মেসেজ': 'Disappearing messages',
  'ডিসঅ্যাপিয়ারিং চালু — ২৪ ঘণ্টার পুরনো মেসেজ দেখা যায় না': 'Disappearing on — messages older than 24 hours are hidden',
  'রিড রিসিপ্ট লুকাও': 'Hide read receipts', 'দেখা হয়েছে': 'Seen', 'ফাইল পাঠাও': 'Send a file',
  'বেগুনি': 'Purple', 'নীল': 'Blue', 'সবুজ': 'Green', 'গোলাপি': 'Pink', 'কমলা': 'Orange', 'লাল': 'Red', 'টিল': 'Teal',
  'ধূসর-নীল': 'Slate', 'গোল্ডেন': 'Golden', 'গাঢ় নীল': 'Deep blue', 'মিন্ট': 'Mint', 'পিচ': 'Peach',
  'পিন করা হয়েছে': 'Pinned', 'পিন সরানো হয়েছে': 'Unpinned', 'মিউট করা হয়েছে': 'Muted', 'আনমিউট করা হয়েছে': 'Unmuted',
  'ডাকনাম দেওয়া হয়েছে ✓': 'Nickname set ✓', 'সম্পাদনা হয়েছে ✓': 'Edited ✓', 'থিম বদলানো হয়েছে': 'Theme changed',
  'ডিসঅ্যাপিয়ারিং চালু হয়েছে': 'Disappearing turned on', 'ডিসঅ্যাপিয়ারিং বন্ধ হয়েছে': 'Disappearing turned off',
  'রিড রিসিপ্ট লুকানো হয়েছে': 'Read receipts hidden', 'রিড রিসিপ্ট দেখানো হবে': 'Read receipts will be shown',
  'ফাইল আপলোড হচ্ছে...': 'Uploading file...', 'খালি মেসেজ হবে না': "Message can't be empty", 'ডাকনাম দেওয়া যাবে না': "Can't set a nickname here",
  'সম্পাদিত': 'edited',
  /* chat pack 2 */
  'আর্কাইভ করা চ্যাট': 'Archived chats', 'রেস্ট্রিক্ট করা চ্যাট': 'Restricted chats', 'এখানে কিছু নেই': 'Nothing here',
  'মেসেজ রিকুয়েস্ট': 'Message requests', 'ব্লক': 'Block', 'তোমাকে মেসেজ পাঠাতে চায়': 'wants to send you a message', 'গ্রহণ করলে চ্যাটটি মূল লিস্টে যাবে': 'Accept to move this chat to your main list', 'গ্রহণ করো': 'Accept', 'রিকুয়েস্ট গ্রহণ করা হয়েছে ✓': 'Request accepted ✓', 'রিকুয়েস্ট মোছা হয়েছে': 'Request deleted',
  'আর্কাইভ থেকে তোলো': 'Unarchive', 'রেস্ট্রিক্ট করো': 'Restrict', 'রেস্ট্রিক্ট সরাও': 'Remove restrict',
  'আর্কাইভ করা হয়েছে': 'Archived', 'আর্কাইভ থেকে তোলা হয়েছে': 'Unarchived',
  'রেস্ট্রিক্ট করা হয়েছে': 'Restricted', 'রেস্ট্রিক্ট সরানো হয়েছে': 'Restrict removed',
  'চ্যাটে খোঁজো': 'Search in chat', 'যা খুঁজছ লেখো...': 'Type what you are looking for...',
  'এই চ্যাটের লেখা মেসেজগুলোর মধ্যে খোঁজো': 'Search the text messages in this chat', 'কোনো ফলাফল নেই': 'No results', 'পাওয়া যায়নি': 'Not found',
  'নতুন পোল': 'New poll', 'প্রশ্ন লেখো': 'Write a question', 'পোল পাঠাও': 'Send poll', 'পোল পাঠানো হয়েছে ✓': 'Poll sent ✓',
  'প্রশ্ন লেখো...': 'Write a question...', 'কমপক্ষে ২টা অপশন দাও': 'Give at least 2 options', 'ভোট দেওয়া যায়নি': "Couldn't vote", 'পোল পাঠানো যায়নি': "Couldn't send the poll",
  'ঘোষণা': 'Announcement', 'ঘোষণা লেখো...': 'Write an announcement...', 'ঘোষণাটা চ্যাটের উপরে পিন হয়ে থাকবে — সব সদস্য দেখবে।': 'The announcement stays pinned at the top of the chat — all members will see it.',
  'ঘোষণা সেভ হয়েছে ✓': 'Announcement saved ✓', 'ঘোষণা মোছো': 'Delete announcement', 'ঘোষণা মোছা হয়েছে': 'Announcement deleted', 'ঘোষণা সেভ হয়নি': "Couldn't save the announcement",
  'গ্রুপ অ্যাডমিন': 'Group admin', 'সদস্যরা': 'Members', 'সরাও': 'Remove', 'সদস্য সরানো হয়েছে': 'Member removed', 'সরানো যায়নি': "Couldn't remove",
  'কে মেসেজ পাঠাতে পারবে': 'Who can message you', 'কে মেসেজ পাঠাতে পারবে?': 'Who can message you?',
  'শুধু নতুন চ্যাট শুরুর ক্ষেত্রে প্রযোজ্য — পুরনো চ্যাট আগের মতোই চলবে।': 'Applies only when a new chat is started — existing chats keep working as before.',
  'কেউ না': 'No one', 'মেসেজ প্রাইভেসি ঠিক হয়েছে ✓': 'Message privacy set ✓',
  'এই ব্যবহারকারী মেসেজ গ্রহণ করেন না': 'This user does not accept messages', 'শুধু বন্ধুরা মেসেজ পাঠাতে পারে': 'Only friends can send messages',
  'তোমার নোট': 'Your note', 'নোট লেখো...': 'Write a note...', 'নোট মোছো': 'Delete note', 'নোট সেভ হয়েছে ✓': 'Note saved ✓', 'নোট মোছা হয়েছে': 'Note deleted', 'নোট সেভ হয়নি': "Couldn't save the note",
  'বন্ধুরা ২৪ ঘণ্টা এই নোটটা চ্যাটের উপরে দেখবে।': 'Friends will see this note above the chat list for 24 hours.',
  'কুইক রিঅ্যাকশন': 'Quick reaction', 'কুইক রিঅ্যাকশন বদলানো হয়েছে': 'Quick reaction changed',
  'এই চ্যাটের মিডিয়া': 'Chat media', 'কোনো মিডিয়া নেই': 'No media yet',
  'বন্ধ করো': 'Close', 'বন্ধুদের সাথে প্রতিদিনের আড্ডা, এক জায়গায়': 'Everyday adda with friends, in one place',
  'তোমার নাম': 'Your name', 'ইমেইল': 'Email', 'পাসওয়ার্ড (কমপক্ষে ৬ অক্ষর)': 'Password (at least 6 characters)',
  'লগ ইন': 'Log in', 'অ্যাকাউন্ট নেই?': "Don't have an account?", 'নতুন অ্যাকাউন্ট খোলো': 'Create a new account',
  'অ্যাকাউন্ট খোলো': 'Create account', 'আগে থেকেই অ্যাকাউন্ট আছে?': 'Already have an account?', 'লগ ইন করো': 'Log in',
  'অ্যাকাউন্ট তৈরি! ইমেইলে পাঠানো লিংকে চাপ দিয়ে নিশ্চিত করে তারপর লগ ইন করো।': 'Account created! Tap the link sent to your email to confirm, then log in.',
  'লগ ইন হয়নি — ইমেইল/পাসওয়ার্ড মিলিয়ে আবার চেষ্টা করো': 'Login failed — check your email/password and try again',
  'নাম, ইমেইল আর কমপক্ষে ৬ অক্ষরের পাসওয়ার্ড দাও': 'Enter your name, email and a password of at least 6 characters',
  'প্রোফাইল তৈরি হয়নি': "Profile couldn't be created",
  /* common */
  'লোড হচ্ছে...': 'Loading...', 'সেভ': 'Save', 'বানাও': 'Create', 'পাঠাও': 'Send', 'খোলো': 'Open',
  'মুছো': 'Delete', 'মুছে ফেলো': 'Delete', '🗑 মুছো': '🗑 Delete', 'সংরক্ষণ করো': 'Save', 'যোগ করো': 'Add',
  'তুমি': 'You', 'ব্যবহারকারী': 'User', 'নতুন মানুষ': 'New person', 'সব': 'All',
  'ছবি': 'Photo', 'দিন': 'days', 'টোকেন': 'Tokens', 'ফলোয়ার': 'Followers', 'পোস্ট': 'Posts',
  /* feed / composer */
  'মনে কী চলছে?': "What's on your mind?", '🛍 বাজার': '🛍 Market', 'সব দেখো': 'See all',
  'পোস্ট করো': 'Post', '🌍 সবাই দেখবে': '🌍 Everyone can see', 'ছবি যোগ করো': 'Add photo',
  '🎬 ভিডিও যোগ করো': '🎬 Add video', '🖼 কোলাজ বানাও (২-৪টি ছবি)': '🖼 Make a collage (2-4 photos)',
  '📊 পোল যোগ করো': '📊 Add a poll', 'জায়গা (ঐচ্ছিক)': 'Location (optional)',
  'অপশন ২': 'Option 2', 'অপশন ৪ (ঐচ্ছিক)': 'Option 4 (optional)',
  'টিপস: #হ্যাশট্যাগ দিলে ট্রেন্ডিংয়ে উঠবে': 'Tip: add #hashtags to show up in Trending',
  'কিছু লেখো, ছবি দাও বা পোল বানাও': 'Write something, add a photo or create a poll',
  'এক পোস্টে ২টার বেশি লিংক দেওয়া যাবে না': "You can't add more than 2 links in one post",
  'একটু ধীরে — ৮ সেকেন্ড পর আবার পোস্ট করো': 'Slow down — post again after 8 seconds',
  'শিডিউলের সময় ভবিষ্যতে দাও': 'Choose a future time for scheduling',
  'পোস্ট হয়েছে ✓': 'Posted ✓', 'পোস্ট হয়েছে ✓ (+১৫ টোকেন)': 'Posted ✓ (+15 tokens)',
  'পোস্ট শিডিউল হয়েছে ⏰': 'Post scheduled ⏰', 'পোস্ট হয়নি, আবার চেষ্টা করো': "Couldn't post — try again",
  'ছবি আপলোড হয়নি': "Photo couldn't be uploaded", 'আপলোড হয়নি': "Couldn't upload",
  '⏰ অনেকক্ষণ ধরে আছো — একটু চোখ আর মনকে বিশ্রাম দাও': "⏰ You've been here a while — give your eyes and mind a rest",
  /* feed banners */
  '🕰 এই দিনে': '🕰 On this day', '— তোমার পুরনো একটা পোস্ট আজকের দিনে হয়েছিল': '— one of your old posts was made on this day',
  'পোস্টটা দেখো': 'View post', 'শুভেচ্ছা জানিয়ে একটা পোস্ট করো': 'Post a greeting', 'শুভেচ্ছা পাঠাও': 'Send greetings',
  'শুভ জন্মদিন': 'Happy birthday', '🎂🎉 অনেক অনেক শুভেচ্ছা!': '🎂🎉 Best wishes!',
  /* post card / menu / comments */
  'পেজ': 'Page', 'বুস্ট করা': 'Boosted', 'লাইক': 'Like', 'মন্তব্য': 'Comments',
  '🖼 ছবি দেখো (ডেটা সেভার)': '🖼 View photo (data saver)',
  'পোস্টের অপশন': 'Post options', '✏️ পোস্ট এডিট করো': '✏️ Edit post', '📌 পিন সরাও': '📌 Unpin',
  '📌 প্রোফাইলে পিন করো': '📌 Pin to profile', '🗄 আর্কাইভ থেকে ফেরাও': '🗄 Restore from archive', '🗄 আর্কাইভ করো': '🗄 Archive',
  '🔊 পোস্ট পড়ে শোনাও': '🔊 Read post aloud', '🌐 ইংরেজিতে অনুবাদ': '🌐 Translate to English',
  '🚀 বুস্ট করো (৫০ টোকেন, ২৪ ঘণ্টা)': '🚀 Boost (50 tokens, 24 hours)', '🚀 এই পোস্ট বুস্ট অবস্থায় আছে': '🚀 This post is boosted',
  '🗑 পোস্ট মুছে ফেলো': '🗑 Delete post', '🚩 রিপোর্ট করো': '🚩 Report', '🚫 এই ব্যবহারকারীকে ব্লক করো': '🚫 Block this user',
  'পোস্ট এডিট': 'Edit post', 'পোস্ট আপডেট হয়েছে': 'Post updated', 'পোস্ট পিন করা হয়েছে 📌': 'Post pinned 📌',
  'পিন সরানো হয়েছে': 'Pin removed', 'পোস্ট আর্কাইভ হয়েছে 🗄': 'Post archived 🗄', 'পোস্ট ফিরিয়ে আনা হয়েছে': 'Post restored',
  'পোস্ট মুছে গেছে': 'Post deleted', 'পোস্ট সেভ হয়েছে': 'Post saved', 'সেভ সরানো হয়েছে': 'Removed from saved',
  'পোস্ট ২৪ ঘণ্টার জন্য বুস্ট হয়েছে 🚀': 'Post boosted for 24 hours 🚀',
  'অনুবাদ হচ্ছে...': 'Translating...', 'অনুবাদ হয়নি — নেট চেক করো': "Couldn't translate — check your connection",
  'অনুবাদের মতো লেখা নেই': 'Nothing to translate', 'শোনানোর মতো লেখা নেই': 'Nothing to read aloud',
  'তুমি ইতিমধ্যে ভোট দিয়েছ': 'You have already voted',
  'মন্তব্য লেখো...': 'Write a comment...', 'এখনো কোনো মন্তব্য নেই — প্রথমটা তুমিই করো': 'No comments yet — be the first',
  'মন্তব্য যায়নি': "Comment couldn't be sent", '🎤 ভয়েস মন্তব্য': '🎤 Voice comment', 'ভয়েস আপলোড হচ্ছে...': 'Uploading voice...',
  'যায়নি': "Couldn't be sent", 'হয়নি': "Couldn't be done",
  /* friends */
  'বন্ধুরা': 'Friends', 'পরামর্শ': 'Suggestions', 'অনুরোধ': 'Requests', 'আমার বন্ধু': 'My friends',
  'বন্ধু যোগ করো': 'Add friend', 'বন্ধু ✓': 'Friends ✓', 'পাঠানো হয়েছে ✓': 'Sent ✓', 'পাঠানো যায়নি': "Couldn't be sent",
  'গ্রহণ': 'Accept', 'নতুন বন্ধু যোগ হয়েছে 🎉': 'New friend added 🎉', 'বন্ধু তালিকা থেকে সরানো হয়েছে': 'Removed from friends',
  'কোনো অনুরোধ নেই': 'No requests', 'এখনো কোনো বন্ধু নেই': 'No friends yet',
  'এখনো কোনো বন্ধু নেই — পরামর্শ ট্যাব থেকে যোগ করো': 'No friends yet — add some from the Suggestions tab',
  'আপাতত নতুন কেউ নেই': 'No one new right now', 'আগে কিছু বন্ধু বানাও': 'Make some friends first',
  'রিপোর্ট / ব্লক': 'Report / Block',
  /* chat */
  'এখনো কোনো চ্যাট নেই।': 'No chats yet.', 'বন্ধুর প্রোফাইল থেকে "মেসেজ" চাপ দিলেই চ্যাট শুরু হবে।': 'Tap "Message" on a friend\'s profile to start a chat.',
  'প্রথম মেসেজটা পাঠাও 👋': 'Send the first message 👋', 'মেসেজ লেখো...': 'Write a message...', 'মেসেজ': 'Message',
  'মেসেজ করো': 'Message', 'চ্যাট খোলা যায়নি': "Chat couldn't be opened", 'মেসেজ যায়নি': "Message couldn't be sent",
  'স্টিকার পাঠাও': 'Send a sticker', '(গ্রুপ)': '(Group)', '· গ্রুপ চ্যাট': '· Group chat',
  /* groups */
  '👥 গ্রুপ': '👥 Groups', '+ নতুন গ্রুপ বানাও': '+ Create a new group', 'এখনো কোনো গ্রুপ নেই — প্রথমটা তুমিই বানাও!': 'No groups yet — create the first one!',
  'নতুন গ্রুপ': 'New group', 'গ্রুপের নাম': 'Group name', 'বিষয় (যেমন: পড়াশোনা, খেলা, গান)': 'Topic (e.g. study, sports, music)',
  'গ্রুপ সম্পর্কে এক লাইন': 'One line about the group', 'গ্রুপ বানাও': 'Create group', 'গ্রুপ তৈরি হয়েছে 🎉': 'Group created 🎉',
  'গ্রুপ তৈরি হয়নি': "Group couldn't be created", 'গ্রুপের নাম দাও': 'Give the group a name', 'গ্রুপে যোগ দিয়েছ ✓': 'You joined the group ✓',
  'গ্রুপ ছেড়েছ': 'You left the group', 'গ্রুপ চ্যাট খোলা যায়নি': "Group chat couldn't be opened",
  '← সব গ্রুপ': '← All groups', 'সদস্য': 'Members', 'গ্রুপে পোস্ট করো': 'Post in group', 'গ্রুপ চ্যাট': 'Group chat',
  'ছাড়ো': 'Leave', 'গ্রুপের পোস্ট': 'Group posts', 'এই গ্রুপে এখনো পোস্ট নেই': 'No posts in this group yet',
  '💰 গ্রুপ তহবিল': '💰 Group fund', 'জমা দাও': 'Contribute', 'টোকেনের পরিমাণ': 'Token amount',
  'জমা আছে — সবাই মিলে ভালো কাজে ব্যবহারের জন্য': 'saved — to be used together for a good cause',
  'তহবিলে জমা হয়েছে 💰': 'Added to the fund 💰', 'হয়নি — টোকেন কম বা তুমি সদস্য নও': "Couldn't do it — not enough tokens or you're not a member",
  'পরিমাণ দাও': 'Enter an amount', 'মালিক:': 'Owner:',
  /* profile */
  'প্রোফাইল পাওয়া যায়নি': 'Profile not found', '🔗 লিংক কপি': '🔗 Copy link', 'QR কোড': 'QR code',
  '👁 কে দেখল': '👁 Who viewed', 'প্রোফাইল এডিট': 'Edit profile', '⚙️ সেটিংস': '⚙️ Settings',
  'ফলো করো': 'Follow', 'ফলো করছ ✓': 'Following ✓', '🎁 উপহার (১০০)': '🎁 Gift (100)', '🙈 বেনামে প্রশ্ন': '🙈 Ask anonymously',
  'পরিচিতি': 'Intro', 'বন্ধুরা ·': 'Friends ·', 'পোস্টসমূহ': 'Posts', 'কোনো ছবির পোস্ট নেই': 'No photo posts',
  'এখনো কোনো পোস্ট নেই': 'No posts yet', 'এখনো কোনো পোস্ট নেই।': 'No posts yet.', 'এখনো পোস্ট নেই': 'No posts yet',
  'নাম': 'Name', 'ইউজারনেম (ইংরেজি ছোট হাতের, যেমন: limon.bd)': 'Username (lowercase English, e.g. limon.bd)',
  'শহর (যেমন: ঢাকা)': 'City (e.g. Dhaka)', '🎂 জন্মদিন': '🎂 Birthday',
  'জরুরি যোগাযোগ (শুধু তুমিই দেখবে)': 'Emergency contact (only you can see this)',
  '💼 কাজ / পেশা (যেমন: ছাত্র, শিক্ষক)': '💼 Work (e.g. student, teacher)', '🎓 পড়াশোনা (যেমন: ঢাকা বিশ্ববিদ্যালয়)': '🎓 Education (e.g. University of Dhaka)',
  '🏠 নিজ শহর (যেমন: রাজশাহী)': '🏠 Hometown (e.g. Rajshahi)', '❤️ সম্পর্কের অবস্থা (ঐচ্ছিক)': '❤️ Relationship status (optional)',
  '👤 লিঙ্গ (ঐচ্ছিক)': '👤 Gender (optional)', '🏷 ডাকনাম (যেমন: লিমন)': '🏷 Nickname (e.g. Limon)',
  '🗣 ভাষা (যেমন: বাংলা, English)': '🗣 Languages (e.g. Bangla, English)', '🌐 ওয়েবসাইট (যেমন: example.com)': '🌐 Website (e.g. example.com)',
  '🎨 শখ (যেমন: বই পড়া, ফুটবল, গান)': '🎨 Hobbies (e.g. reading, football, music)', '💬 পছন্দের উক্তি': '💬 Favourite quote',
  'নিজের সম্পর্কে দু-এক লাইন': 'A line or two about yourself', 'প্রোফাইল ছবি': 'Profile photo', 'কভার ছবি': 'Cover photo',
  'অবিবাহিত': 'Single', 'সম্পর্কে আছি': 'In a relationship', 'বিবাহিত': 'Married', 'জটিল': "It's complicated",
  'পুরুষ': 'Male', 'মহিলা': 'Female', 'অন্যান্য': 'Other',
  'ইউজারনেমে শুধু ইংরেজি ছোট হাতের অক্ষর, সংখ্যা, . আর _ (৩-৩০)': 'Username can only have lowercase English letters, numbers, . and _ (3-30)',
  'এই ইউজারনেম অন্য কেউ নিয়েছে': 'Someone else has taken this username', 'প্রোফাইল আপডেট হয়েছে ✓': 'Profile updated ✓',
  'সংরক্ষণ হয়নি': "Couldn't save", 'প্রোফাইল লিংক কপি হয়েছে 🔗': 'Profile link copied 🔗',
  'আগে প্রোফাইল এডিটে একটা ইউজারনেম সেট করো': 'Set a username in Edit Profile first',
  '⚠️ সতর্কতা: এই অ্যাকাউন্টের বিরুদ্ধে একাধিক রিপোর্ট আছে — লেনদেনে সাবধান': '⚠️ Caution: multiple reports exist against this account — be careful with transactions',
  '🚩 এই প্রোফাইল রিপোর্ট করো': '🚩 Report this profile', '🚫 ব্লক করো': '🚫 Block',
  'রিপোর্ট পাঠানো হয়েছে — ধন্যবাদ': 'Report sent — thank you', 'ব্লক করা হয়েছে': 'Blocked',
  /* notifications */
  'তোমার পোস্টে লাইক দিয়েছে': 'liked your post', 'তোমার পোস্টে মন্তব্য করেছে': 'commented on your post',
  'তোমাকে বন্ধুর অনুরোধ পাঠিয়েছে': 'sent you a friend request', 'তোমার বন্ধুর অনুরোধ গ্রহণ করেছে': 'accepted your friend request',
  'তোমাকে ফলো করেছে': 'followed you', 'তোমাকে ১০০ টোকেন উপহার পাঠিয়েছে': 'sent you a gift of 100 tokens',
  'তোমার সাথে ম্যাচ হয়েছে 💘': 'matched with you 💘', 'তোমাকে মেসেজ পাঠিয়েছে': 'sent you a message',
  '🙈 তোমার কাছে একটা বেনামি প্রশ্ন এসেছে': '🙈 You received an anonymous question', 'নতুন আপডেট': 'New update',
  'কোনো নোটিফিকেশন নেই': 'No notifications',
  /* search / trending */
  'মানুষ, পোস্ট বা গ্রুপ খোঁজো...': 'Search people, posts or groups...', 'কমপক্ষে ২ অক্ষর লেখো': 'Type at least 2 characters',
  'ট্রেন্ডিং': 'Trending', 'জনপ্রিয় পোস্ট': 'Popular posts',
  'এই সপ্তাহে এখনো কোনো হ্যাশট্যাগ ট্রেন্ড হয়নি — পোস্টে #ট্যাগ ব্যবহার করো!': 'No hashtag has trended this week yet — use #tags in posts!',
  'নাম, জায়গা বা যেকোনো শব্দ লিখে খোঁজো': 'Search by name, place or any word',
  /* tokens */
  'তোমার ব্যালেন্স': 'Your balance', 'প্রতিদিন লগইন, পোস্ট আর মন্তব্য করে টোকেন আয় করো': 'Earn tokens by logging in, posting and commenting every day',
  '🔥 লগইন স্ট্রিক:': '🔥 Login streak:', 'টোকেন আয় করো': 'Earn tokens', 'টোকেন খরচ করো': 'Spend tokens',
  'প্রতিদিন লগইন': 'Daily login', 'প্রতিদিন একবার': 'Once a day', 'দিনে সর্বোচ্চ ৫টি পোস্টে': 'On up to 5 posts a day',
  'দিনে সর্বোচ্চ ১০টি': 'Up to 10 a day', 'স্বাগত বোনাস': 'Welcome bonus', 'নতুন অ্যাকাউন্টে একবার': 'Once, for new accounts',
  'পোস্ট বুস্ট': 'Post boost', 'নিজের পোস্টের ⋯ মেনু থেকে, ২৪ ঘণ্টা সবার উপরে': "From your post's ⋯ menu — stays on top for 24 hours",
  'বন্ধুকে উপহার': 'Gift a friend', 'বন্ধুর প্রোফাইল থেকে পাঠাও': "Send it from your friend's profile",
  'প্রিমিয়াম ব্যাজ': 'Premium badge', 'অ্যাডমিন ড্যাশবোর্ড': 'Admin dashboard', 'মোট ব্যবহারকারী': 'Total users', 'মোট পোস্ট': 'Total posts', 'রিপোর্টসমূহ': 'Reports', 'ব্যবহারকারী': 'Users', 'পোস্টটি দেখো': 'View post', 'পোস্ট মুছো': 'Delete post', 'রিপোর্ট বাতিল': 'Dismiss', 'কোনো রিপোর্ট নেই': 'No reports', 'ভেরিফাই করো': 'Verify', 'ভেরিফাইড': 'Verified', 'ব্যাজ দাও': 'Give badge', 'ব্যাজ সরাও': 'Remove badge', 'প্রোফাইল দেখো': 'View profile', 'কয়েন': 'Tokens', 'কয়েন ঠিক করো': 'Adjust tokens', 'যোগ করো': 'Add', 'কমাও': 'Subtract', 'নামের পাশে সোনালি ব্যাজ': 'A golden badge next to your name',
  '২০০ দিয়ে কেনো': 'Buy for 200', 'ইতিহাস': 'History', 'এখনো কোনো লেনদেন নেই': 'No transactions yet',
  'টোকেন যথেষ্ট নেই': 'Not enough tokens', 'টোকেন যথেষ্ট নেই (লাগবে ১০০)': 'Not enough tokens (needs 100)',
  'টোকেন যথেষ্ট নেই (লাগবে ২০০)': 'Not enough tokens (needs 200)', 'অভিনন্দন! প্রিমিয়াম ব্যাজ পেয়ে গেছ 👑': 'Congratulations! You got the premium badge',
  '১০০ টোকেন উপহার পাঠানো হয়েছে 🎁': 'A gift of 100 tokens was sent 🎁', 'উপহার পাঠিয়েছ': 'Gift sent', 'উপহার পেয়েছ 🎁': 'Gift received 🎁',
  'স্বাগত বোনাস 🎉': 'Welcome bonus 🎉', 'দৈনিক লগইন বোনাস': 'Daily login bonus', 'পোস্ট করার পুরস্কার': 'Post reward',
  'মন্তব্যের পুরস্কার': 'Comment reward', 'বন্ধু আমন্ত্রণের পুরস্কার': 'Friend invite reward', 'কুইজ পুরস্কার': 'Quiz reward',
  'গ্রুপ তহবিলে জমা': 'Group fund contribution', 'প্রোফাইল থিম': 'Profile theme',
  /* settings */
  'সেটিংস': 'Settings', 'আমার জিনিস': 'My things', '✏️ প্রোফাইল এডিট': '✏️ Edit profile', '🪙 টোকেন ওয়ালেট': '🪙 Token wallet',
  '🔥 লগইন স্ট্রিক': '🔥 Login streak', '🗄 আর্কাইভ করা পোস্ট': '🗄 Archived posts', '🔖 সেভ করা পোস্ট': '🔖 Saved posts',
  '👁 প্রোফাইল দর্শক': '👁 Profile viewers', '🖼 আমার অ্যালবাম': '🖼 My albums', '📥 আমার ডেটা ডাউনলোড': '📥 Download my data',
  'তোমার ডেটা তৈরি হচ্ছে...': 'Preparing your data...', 'ডেটা ডাউনলোড হয়েছে 📥': 'Data downloaded 📥',
  'মজা ও শেখা': 'Fun & learning', '📊 ক্রিয়েটর ড্যাশবোর্ড': '📊 Creator dashboard', '🎨 প্রোফাইল থিম': '🎨 Profile themes',
  'কমিউনিটি': 'Community', '📄 পেজ': '📄 Pages', '📅 ইভেন্ট': '📅 Events', '🛍 আড্ডা বাজার': '🛍 Adda Market',
  '🤝 সেবা বোর্ড (রক্ত · হারানো · চাকরি)': '🤝 Service board (blood · lost & found · jobs)', '🏛 সরকারি সেবা': '🏛 Government services',
  'নিরাপত্তা ও প্রাইভেসি': 'Security & privacy', '🔑 পাসওয়ার্ড বদলাও': '🔑 Change password',
  '🎯 নতুন পোস্ট কে দেখবে (ডিফল্ট)': '🎯 Who can see new posts (default)', '🚫 ব্লক করা মানুষ': '🚫 Blocked people',
  'ℹ️ আড্ডাBook সম্পর্কে': 'ℹ️ About AddaBook', '📵 সব ডিভাইস থেকে লগ আউট': '📵 Log out of all devices',
  'সুবিধা ও নিরাপত্তা': 'Comfort & safety', '🌙 ডার্ক / লাইট থিম': '🌙 Dark / light theme', 'থিম বদলানো হয়েছে': 'Theme changed',
  '🔠 সহজ মোড (বড় লেখা)': '🔠 Easy mode (big text)', '📶 ডেটা সেভার মোড (ছবি চাপ দিলে লোড)': '📶 Data saver mode (tap to load photos)',
  '🧒 কিড মোড (ডেটিং লুকানো)': '🧒 Kid mode (dating hidden)', '🚪 লগ আউট': '🚪 Log out',
  'নতুন পাসওয়ার্ড (কমপক্ষে ৬ অক্ষর)': 'New password (at least 6 characters)', 'আবার লেখো': 'Type it again', 'বদলে ফেলো': 'Change it',
  'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে': 'Password must be at least 6 characters', 'দুটো পাসওয়ার্ড মিলছে না': "The two passwords don't match",
  'বদলানো যায়নি — আবার লগইন করে চেষ্টা করো': "Couldn't change it — log in again and try", 'পাসওয়ার্ড বদলানো হয়েছে 🔑': 'Password changed 🔑',
  '🎯 নতুন পোস্ট কে দেখবে?': '🎯 Who can see new posts?',
  'পোস্ট করার সময় এই অপশনটা আগেই বেছে থাকবে — চাইলে পোস্টের সময় বদলাতেও পারবে।': 'This option will be pre-selected when you post — you can still change it while posting.',
  '🌍 সবাই': '🌍 Everyone', '👥 শুধু বন্ধুরা': '👥 Friends only', '💚 কাছের বন্ধুরা': '💚 Close friends', '⭐ ফলোয়াররা': '⭐ Followers',
  'ডিফল্ট ঠিক হয়েছে ✓': 'Default set ✓', 'সবাই': 'Everyone', 'বন্ধুরা': 'Friends', 'কাছের বন্ধুরা': 'Close friends', 'ফলোয়াররা': 'Followers',
  'কাউকে ব্লক করোনি': "You haven't blocked anyone", 'আনব্লক': 'Unblock', 'আনব্লক করা হয়েছে': 'Unblocked',
  'আড্ডাBook — বন্ধুদের সাথে প্রতিদিনের আড্ডার নিজের জায়গা। বানিয়েছে': 'AddaBook — your own place for everyday adda with friends. Made by',
  'নিরাপত্তা টিপস:': 'Safety tips:', 'পাসওয়ার্ড কারো সাথে শেয়ার করো না। কেনাবেচায় অগ্রিম টাকা পাঠানোর আগে যাচাই করো। সন্দেহজনক পোস্টে রিপোর্ট করো।': "Never share your password with anyone. Verify before sending money in advance for a purchase. Report suspicious posts.",
  '📌 সংস্করণ: v2 (২০২৬)': '📌 Version: v2 (2026)',
  'চালু হয়েছে': 'On', 'বন্ধ হয়েছে': 'Off',
  /* saved / archived / viewers */
  'সেভ করা পোস্ট': 'Saved posts', 'কোনো সেভ করা পোস্ট নেই': 'No saved posts', 'আর্কাইভে কিছু নেই': 'Nothing in the archive',
  'এখনো কেউ তোমার প্রোফাইল দেখেনি': 'No one has viewed your profile yet',
  /* creator */
  'মোট পোস্ট': 'Total posts', 'মোট লাইক': 'Total likes', 'মোট মন্তব্য': 'Total comments', 'প্রোফাইল ভিউ': 'Profile views',
  'দিনের স্ট্রিক': 'day streak', '📅 সাপ্তাহিক রিপোর্ট (গত ৭ দিন)': '📅 Weekly report (last 7 days)',
  'এই সপ্তাহে তুমি': 'This week you posted', 'পোস্ট করেছ। মোট লাইক': 'posts. Total likes', ', মন্তব্য': ', comments',
  'দারুণ চলছে — এভাবেই চালিয়ে যাও! 🎉': 'Going great — keep it up! 🎉', 'এই সপ্তাহে একটা পোস্ট করে শুরু করো!': 'Start this week with a post!',
  '🏆 তোমার সেরা পোস্ট': '🏆 Your best post', 'টি': '',
  /* albums */
  '🖼 ছবির অ্যালবাম': '🖼 Photo albums', 'কোনো অ্যালবাম নেই': 'No albums', 'নতুন অ্যালবাম': 'New album',
  'অ্যালবামের নাম (যেমন: কক্সবাজার ভ্রমণ)': "Album name (e.g. Cox's Bazar trip)", 'অ্যালবাম তৈরি ✓': 'Album created ✓',
  'এখনো ছবি নেই': 'No photos yet',
  /* pages */
  '+ নতুন পেজ বানাও': '+ Create a new page', 'এখনো কোনো পেজ নেই': 'No pages yet', 'নতুন পেজ': 'New page', 'পেজ বানাও': 'Create page',
  'পেজ সম্পর্কে': 'About the page', 'পেজ তৈরি ✓': 'Page created ✓', 'পেজে পোস্ট করো': 'Post to page', 'পেজের পোস্ট': 'Page post',
  'এই পেজে এখনো পোস্ট নেই': 'No posts on this page yet',
  /* events */
  '+ নতুন ইভেন্ট': '+ New event', 'সামনে কোনো ইভেন্ট নেই — তুমিই একটা বানাও!': 'No upcoming events — create one!',
  'নতুন ইভেন্ট': 'New event', 'জায়গা': 'Place', 'ইভেন্ট বানাও': 'Create event', 'ইভেন্ট তৈরি ✓': 'Event created ✓',
  'নাম আর সময় দাও': 'Give a name and time', 'যাচ্ছ ✓': 'Going ✓', 'আমি যাব': "I'm going",
  /* service board */
  '🤝 সেবা বোর্ড': '🤝 Service board', '🩸 রক্ত': '🩸 Blood', '🔍 হারানো-প্রাপ্তি': '🔍 Lost & found', '💼 চাকরি': '💼 Jobs',
  '+ নতুন পোস্ট দাও': '+ Add a post', '🩸 রক্তের আবেদন': '🩸 Blood request', 'রক্তের গ্রুপ দাও': 'Give the blood group',
  'হারিয়ে গেছে': 'Lost', 'পাওয়া গেছে': 'Found', 'কী জিনিস?': 'What item?', 'কোন এলাকায়?': 'In which area?',
  'জিনিসের নাম দাও': "Give the item's name", '💼 চাকরির পোস্ট': '💼 Job post', 'পদের নাম দাও': 'Give the job title',
  'এই ক্যাটাগরিতে কিছু নেই': 'Nothing in this category', 'রক্ত দরকার': 'Blood needed',
  /* market */
  '+ বিজ্ঞাপন দাও': '+ Post an ad', '🛍 নতুন বিজ্ঞাপন': '🛍 New ad', 'জিনিসের নাম': "Item's name",
  'বিক্রি': 'For sale', 'ফ্রি': 'Free', 'সেবা': 'Service', 'অফার': 'Offer', 'বই বিনিময়': 'Book exchange',
  'দাম টাকায় (ফ্রি হলে ০ দাও)': 'Price in taka (put 0 if free)', 'বিজ্ঞাপন দাও': 'Post ad', 'বিজ্ঞাপন দেওয়া হয়েছে ✓': 'Ad posted ✓',
  '⚠️ কেনাবেচায় নিজে যাচাই করে লেনদেন করো — অগ্রিম টাকা পাঠানোর আগে সাবধান।': '⚠️ Verify things yourself when buying or selling — be careful before sending money in advance.',
  /* gov corners */
  '🏛 সরকারি সেবা ও কর্নার': '🏛 Government services & corners', '🏛 সরকারি সেবার লিংক': '🏛 Government service links',
  'সবগুলোই সরকারি অফিসিয়াল ওয়েবসাইট — লিংকে গিয়ে সরাসরি সেবা নাও।': 'All of these are official government websites — follow the link to get the service directly.',
  'জাতীয় পোর্টাল (সব সেবা এক জায়গায়)': 'National portal (all services in one place)', 'জাতীয় পরিচয়পত্র (NID) সেবা': 'National ID (NID) services',
  'জন্ম নিবন্ধন': 'Birth registration', 'ই-পাসপোর্ট': 'E-passport', 'শিক্ষা বোর্ডের ফলাফল': 'Education board results',
  'বাংলাদেশ পুলিশ': 'Bangladesh Police', 'BRTA (ড্রাইভিং লাইসেন্স, গাড়ি)': 'BRTA (driving licence, vehicles)',
  'বিদ্যুৎ বিল ও সেবা (DESCO)': 'Electricity bills & services (DESCO)',
  '📚 পড়াশোনা কর্নার': '📚 Study corner', '🍳 রেসিপি কর্নার': '🍳 Recipe corner', '✈️ ভ্রমণ কর্নার': '✈️ Travel corner',
  /* close friends / anon */
  'পোস্ট করার সময় "কাছের বন্ধুরা" বেছে নিলে শুধু এরাই দেখবে।': 'If you choose "Close friends" while posting, only these people will see it.',
  '🙈 বেনামি প্রশ্নের ইনবক্স': '🙈 Anonymous question inbox',
  'বন্ধুরা তোমার প্রোফাইল থেকে বেনামে প্রশ্ন করতে পারে। উত্তর দিলে সেটা তোমার উত্তরের জায়গায় দেখা যাবে।': 'Friends can ask you anonymous questions from your profile. When you answer, it will appear in your answers.',
  'এখনো কোনো বেনামি প্রশ্ন আসেনি': 'No anonymous questions yet', 'উত্তর লেখো...': 'Write an answer...', 'উত্তর দাও': 'Answer',
  'উত্তর দেওয়া হয়েছে': 'Answered', '🙈 বেনামে প্রশ্ন করো': '🙈 Ask anonymously',
  'তোমার নাম ওর কাছে যাবে না। ভদ্রভাবে প্রশ্ন করো।': "Your name won't be shown to them. Please ask politely.",
  'তোমার প্রশ্ন...': 'Your question...', 'বেনামে প্রশ্ন পাঠানো হয়েছে 🙈': 'Anonymous question sent 🙈',
  /* themes */
  '১০০ টোকেনে প্রিমিয়াম থিম কিনলে তোমার প্রোফাইলের কভার জায়গায় সেই রঙ ঝলমল করবে। ব্যালেন্স:': "Buy a premium theme for 100 tokens and that colour will shine on your profile cover. Balance:",
  '১০০ টোকেনে নাও': 'Get it for 100 tokens', 'থিম চালু হয়েছে 🎨': 'Theme applied 🎨', 'থিম সরানো হয়েছে': 'Theme removed',
  'রাতের আকাশ': 'Night sky', 'সূর্যাস্ত': 'Sunset', 'সাগর': 'Ocean', 'বন': 'Forest', 'রাজকীয়': 'Royal',
  /* stories */
  '📸 নতুন স্টোরি (২৪ ঘণ্টা থাকবে)': '📸 New story (stays for 24 hours)', '🖼 ছবি': '🖼 Photo', '🎤 ভয়েস': '🎤 Voice',
  'লেখা (ঐচ্ছিক)': 'Text (optional)', 'স্টোরি দাও': 'Add story', 'ছবি, ভয়েস বা লেখা দাও': 'Add a photo, voice note or text',
  'স্টোরি দেওয়া হয়েছে ✓': 'Story added ✓', 'স্টোরি হয়নি': "Story couldn't be added", 'স্টোরি মোছা হয়েছে': 'Story deleted',
  '💬 রিপ্লাই দাও': '💬 Reply',
  /* dating */
  'মনের মানুষ 💘': 'Find your person 💘', 'আলাদা একটা জায়গা, যেখানে মনের মিল খুঁজে পাবে।': 'A separate little place to find someone who matches your heart.',
  'শুধু ১৮+ দের জন্য · সম্পূর্ণ ঐচ্ছিক · ম্যাচ হলেই চ্যাট': '18+ only · Completely optional · Chat only after a match',
  'তোমার ডেটিং প্রোফাইল': 'Your dating profile', 'আমার ডেটিং প্রোফাইল': 'My dating profile', 'আমার প্রোফাইল': 'My profile',
  'তুমি —': 'You are —', 'খুঁজছ —': 'Looking for —', 'ছেলে': 'Male', 'মেয়ে': 'Female', 'সবাইকে': 'Everyone',
  'পছন্দ বেছে নাও (ম্যাচ % এগুলো দিয়েই হিসাব হয়):': 'Pick your interests (match % is calculated from these):',
  'প্রোফাইল চালু করো': 'Turn on profile', 'ডেটিং বন্ধ করো': 'Turn off dating',
  'ডেটিং প্রোফাইল চালু হয়েছে 💘': 'Dating profile turned on 💘', 'ডেটিং প্রোফাইল বন্ধ করা হয়েছে': 'Dating profile turned off',
  'ডেটিং শুধু ১৮ বছর বা তার বেশি বয়সীদের জন্য': 'Dating is only for people aged 18 or older',
  'তোমার ম্যাচ': 'Your matches', 'এখনো ম্যাচ হয়নি — পছন্দের প্রোফাইলে ❤ দাও': 'No matches yet — tap ❤ on profiles you like',
  'ম্যাচ হয়েছে! 💘 এখন চ্যাট করতে পারো': "It's a match! 💘 You can chat now",
  'লাইক পাঠানো হয়েছে ❤': 'Like sent ❤', 'সুপার লাইক পাঠানো হয়েছে ★': 'Super like sent ★', 'মেসেজ 💘': 'Message 💘',
  'এলাকার কাছাকাছি': 'Nearby', 'আপাতত আর কেউ নেই।': 'No one else right now.', 'পরে আবার দেখো — নতুন মানুষ যোগ দিলে এখানে আসবে।': 'Check back later — new people will appear here when they join.',
  '🛡 ম্যাচ ছাড়া কেউ তোমাকে মেসেজ পাঠাতে পারবে না। বিরক্তিকর কাউকে ব্লক করো — সে আর তোমাকে দেখতে পাবে না।': "🛡 No one can message you without a match. Block anyone who bothers you — they won't be able to see you anymore.",
  '🛡 নিরাপত্তা: কেউ বিরক্ত করলে সাথে সাথে ব্লক/রিপোর্ট করো। কারো সাথে দেখা করতে গেলে পাবলিক জায়গা বেছে নাও, বন্ধুকে জানিয়ে যাও। ব্যক্তিগত তথ্য (ঠিকানা, পাসওয়ার্ড) কাউকে দিও না।': "🛡 Safety: block/report anyone who bothers you right away. If you meet someone, choose a public place and tell a friend. Never give anyone personal information (address, password).",
  'গান': 'Music', 'সিনেমা': 'Movies', 'ক্রিকেট': 'Cricket', 'বই পড়া': 'Reading', 'ভ্রমণ': 'Travel',
  'রান্না': 'Cooking', 'ফটোগ্রাফি': 'Photography', 'কবিতা': 'Poetry', 'খেলাধুলা': 'Sports', 'প্রযুক্তি': 'Technology',
  /* disabled-feature guards + misc */
  'কুইজ আপাতত বন্ধ আছে': 'The quiz is off for now', 'এই অংশটা আপাতত বন্ধ আছে': 'This section is off for now',
  'কিড মোডে এই অংশ বন্ধ আছে': 'This section is off in Kid mode',
  'ভিডিও আপলোড হচ্ছে...': 'Uploading video...', 'মোছা হয়েছে': 'Deleted',
  'এখনো কিছু নেই': 'Nothing here yet', 'এখনো কোনো ভিডিও পোস্ট নেই — পোস্ট করার সময় ভিডিও যোগ করো': 'No video posts yet — add a video when you post',
  '🎬 ভিডিও': '🎬 Videos', 'প্রথম পোস্টটা তুমিই করো — পাবে ১৫ টোকেন!': 'Make the first post — you will get 15 tokens!',
  'প্রথম মেসেজটা পাঠাও 👋': 'Send the first message 👋',
  'আড্ডা': 'Adda',
  'তুমি ＋': 'You ＋', '💘 মনের মানুষ': '💘 Dating', 'মনের মানুষ': 'Dating', 'নতুন পোস্ট': 'New post',
  'অনুভূতি (ঐচ্ছিক)': 'Feeling (optional)', 'পরে প্রকাশ করতে চাইলে সময় দাও': 'Set a time to publish later',
  'অপশন ১': 'Option 1', 'অপশন ৩ (ঐচ্ছিক)': 'Option 3 (optional)',
  'বন্ধ': 'Off', 'চালু': 'On', 'সাধারণ': 'General', 'গ্রুপ': 'Groups',
  '+১০': '+10', '+১৫': '+15', '+৩': '+3', '+১০০': '+100', '৫০': '50', '১০০': '100',
  'মন্তব্য করো': 'Comment', 'নামের পাশে সোনালি ব্যাজ — তোমার আছে ✓': 'A golden badge next to your name — you have it ✓',
  '। দারুণ চলছে — এভাবেই চালিয়ে যাও! 🎉': '. Going great — keep it up! 🎉',
  '। এই সপ্তাহে একটা পোস্ট করে শুরু করো!': '. Start this week with a post!',
  'পেজের নাম': 'Page name', 'ধরন (যেমন: ব্যবসা, কমিউনিটি, ব্লগ)': 'Category (e.g. business, community, blog)',
  'ইভেন্টের নাম': 'Event name',
  'রক্তের গ্রুপ (যেমন: B+)': 'Blood group (e.g. B+)', 'হাসপাতাল': 'Hospital', 'এলাকা': 'Area',
  'পদের নাম': 'Job title', 'প্রতিষ্ঠান': 'Company',
  '🔍 হারিয়ে গেছে:': '🔍 Lost:', '🔍 পাওয়া গেছে:': '🔍 Found:',
  '+ নতুন অ্যালবাম': '+ New album', '+ ছবি যোগ করো': '+ Add photos',
  'কাছের ✓ সরাও': 'Close friend ✓ Remove', 'কাছের করো': 'Make close friend',
  'বয়স (১৮ বা তার বেশি)': 'Age (18 or older)',
  'নতুন অভ্যাস': 'New habit', 'অভ্যাসের নাম (যেমন: ১০ পৃষ্ঠা বই পড়া)': 'Habit name (e.g. read 10 pages of a book)',
  '🏛 জাতীয় পোর্টাল (সব সেবা এক জায়গায়)': '🏛 National portal (all services in one place)',
  '🆔 জাতীয় পরিচয়পত্র (NID) সেবা': '🆔 National ID (NID) services', '📜 জন্ম নিবন্ধন': '📜 Birth registration',
  '🛂 ই-পাসপোর্ট': '🛂 E-passport', '🎓 শিক্ষা বোর্ডের ফলাফল': '🎓 Education board results',
  '👮 বাংলাদেশ পুলিশ': '👮 Bangladesh Police', '🚗 BRTA (ড্রাইভিং লাইসেন্স, গাড়ি)': '🚗 BRTA (driving licence, vehicles)',
  '💡 বিদ্যুৎ বিল ও সেবা (DESCO)': '💡 Electricity bills & services (DESCO)'
};

/* Anchored patterns for composed UI strings. $1/$2… keep user values & numbers verbatim. */
const I18N_VALS = { 'ছেলে': 'Male', 'মেয়ে': 'Female', 'অন্যান্য': 'Other', 'সবাইকে': 'Everyone',
  'পুরুষ': 'Male', 'মহিলা': 'Female', 'অবিবাহিত': 'Single', 'সম্পর্কে আছি': 'In a relationship', 'বিবাহিত': 'Married', 'জটিল': "It's complicated", 'সাধারণ': 'General',
  'গান': 'Music', 'সিনেমা': 'Movies', 'ক্রিকেট': 'Cricket', 'বই পড়া': 'Reading', 'ভ্রমণ': 'Travel',
  'রান্না': 'Cooking', 'ফটোগ্রাফি': 'Photography', 'কবিতা': 'Poetry', 'খেলাধুলা': 'Sports', 'প্রযুক্তি': 'Technology' };
const i18nVal = v => I18N_VALS[v] || v;
const I18N_PATTERNS = [
  [/^(\d+) লাইক$/, (m, n) => n + (n === '1' ? ' like' : ' likes')], [/^(\d+) মন্তব্য$/, (m, n) => n + (n === '1' ? ' comment' : ' comments')], [/^(\d+)টি ভোট$/, (m, n) => n + (n === '1' ? ' vote' : ' votes')],
  [/^(\d+) অক্ষর$/, '$1 characters'], [/^(\d+) জন বন্ধু$/, '$1 friends'], [/^(\d+) জন$/, '$1 people'],
  [/^(\d+) টোকেন$/, '$1 tokens'], [/^🪙 টোকেন: (\d+)$/, '🪙 Tokens: $1'],
  [/^(\d+) টি পোস্ট$/, '$1 posts'], [/^(\d+)% ম্যাচ$/, '$1% match'],
  [/^বাংলাদেশে ট্রেন্ডিং · (\d+)টি পোস্ট$/, 'Trending in Bangladesh · $1 posts'],
  [/^(\d+) জন যাচ্ছে · আয়োজক: (.+)$/, '$1 going · Organizer: $2'],
  [/^🎂 আজ (.+)-এর জন্মদিন!$/, "🎂 Today is $1's birthday!"],
  [/^(.+)-এর সাথে (\d+) বছর বন্ধুত্ব!$/, 'Friends with $1 for $2 years!'],
  [/^🔥 ধারাবাহিকতা: (\d+) দিন · মোট (\d+) বার$/, '🔥 Streak: $1 days · $2 times in total'],
  [/^মনে কী চলছে, (.+)\?$/, "What's on your mind, $1?"],
  [/^📅 যোগ দিয়েছেন (.+)$/, '📅 Joined $1'],
  [/^বয়স: (\d+) · (.*) · খুঁজছ: (.*)$/, (m, a, g, l) => 'Age: ' + a + ' · ' + i18nVal(g) + ' · Looking for: ' + i18nVal(l)],
  [/^পছন্দ: (.+)$/, (m, list) => 'Interests: ' + list.split(', ').map(i18nVal).join(', ')],
  [/^([^\n]+) · গ্রুপ চ্যাট$/, '$1 · Group chat'],
  [/^হয়নি: (.+)$/, 'Failed: $1'],
  [/^(\d+) দিনের স্ট্রিক$/, '$1-day streak'],
  [/^([\d,]+) টোকেন$/, '$1 tokens'],
  [/^বন্ধুরা · (\d+)$/, 'Friends · $1'],
  [/^🪙 (\d+) টোকেন · 🔥 (\d+) দিনের স্ট্রিক$/, '🪙 $1 tokens · 🔥 $2-day streak'],
  [/^(\d+) দিন$/, (m, n) => n + (n === '1' ? ' day' : ' days')], [/^🔥 লগইন স্ট্রিক: (\d+) দিন$/, (m, n) => '🔥 Login streak: ' + n + (n === '1' ? ' day' : ' days')],
  [/^(\d+)টি$/, '$1'],
  [/^📍 থাকেন (.+)$/, '📍 Lives in $1'], [/^🎂 জন্মদিন (.+)$/, '🎂 Birthday $1'], [/^🏠 নিজ শহর (.+)$/, '🏠 Hometown $1'],
  [/^থাকেন (.+)$/, 'Lives in $1'], [/^জন্মদিন (.+)$/, 'Birthday $1'], [/^নিজ শহর (.+)$/, 'Hometown $1'], [/^ভাষা (.+)$/, 'Languages $1'], [/^শখ (.+)$/, 'Hobbies $1'],
  [/^❤️ (.+)$/, (m, v) => '❤️ ' + i18nVal(v)], [/^👤 (.+)$/, (m, v) => '👤 ' + i18nVal(v)],
  [/^🗣 ভাষা (.+)$/, '🗣 Languages $1'], [/^🎨 শখ (.+)$/, '🎨 Hobbies $1'],
  [/^(.+) রক্ত দরকার$/, '$1 blood needed'],
  [/^(.+) · (\d+) ফলোয়ার$/, '$1 · $2 followers'],
  [/^(.+) · (\d+) সদস্য$/, (m, c, n) => i18nVal(c) + ' · ' + n + ' members'],
  [/^· (\d+) সদস্য$/, '· $1 members'],
  [/^📍 (.+) · বন্ধু$/, '📍 $1 · Friend'], [/^📍 (.+) · তুমি$/, '📍 $1 · You'],
  [/^দেখা হয়েছে · (.+)$/, 'Seen · $1'],
  [/^(.+) লিখছে\.\.\.$/, '$1 is typing...']
];
/* Distinctive fragments for strings glued inside a larger text node. Longest first. */
const I18N_FRAGS = [
  ['জমা আছে — সবাই মিলে ভালো কাজে ব্যবহারের জন্য', 'saved — to be used together for a good cause'],
  [' — তোমার পুরনো একটা পোস্ট আজকের দিনে হয়েছিল', ' — one of your old posts was made on this day'],
  ['পোস্ট করেছ। মোট লাইক', 'posts. Total likes'], ['এই সপ্তাহে তুমি', 'This week you posted'],
  [' · গ্রুপ চ্যাট', ' · Group chat'], ['অনুভূতি: ', 'feeling: '], ['দিনের স্ট্রিক', 'day streak'],
  ['জন বন্ধু', 'friends'], ['টি পোস্ট', 'posts'], [', মন্তব্য', ', comments'], ['হয়নি: ', 'Failed: '],
  ['যোগ দিয়েছেন', 'Joined'], ['টোকেন', 'tokens'], ['।', '.']
].sort((a, b) => b[0].length - a[0].length);

function i18nText(txt){
  if (!txt || !/[\u0980-\u09FF]/.test(txt)) return txt;
  const lead = /^\s*/.exec(txt)[0], trail = /\s*$/.exec(txt)[0];
  const core = txt.trim();
  if (!core) return txt;
  let out = null;
  if (Object.prototype.hasOwnProperty.call(I18N, core)) out = I18N[core];
  if (out === null){
    for (const [re, rep] of I18N_PATTERNS){ if (re.test(core)){ out = core.replace(re, rep); break; } }
  }
  if (out === null){
    let t = core, changed = false;
    for (const [f, r] of I18N_FRAGS){ if (t.includes(f)){ t = t.split(f).join(r); changed = true; } }
    if (changed) out = t;
  }
  return out === null ? txt : lead + out + trail;
}
function i18nSkip(node){
  const el = node.parentElement;
  if (!el) return true;
  if (el.closest('.ptext, .msg, .usercontent, script, style, textarea')) return true;
  if (el.closest('#clist') && el.tagName === 'SMALL' && (el.getAttribute('style') || '').includes('display:block')) return true;
  const st = node.nodeValue.trim(); if (el.closest('button.story') && st !== 'তুমি' && st !== 'তুমি ＋') return true;
  return false;
}
function i18nNode(node){
  if (i18nSkip(node)) return;
  const v = i18nText(node.nodeValue);
  if (v !== node.nodeValue) node.nodeValue = v;
}
function i18nAttrs(el){
  for (const at of ['placeholder', 'aria-label', 'title']){
    const v = el.getAttribute && el.getAttribute(at);
    if (v){ const t = i18nText(v); if (t !== v) el.setAttribute(at, t); }
  }
}
function i18nApply(root){
  if (!root) return;
  if (root.nodeType === 3){ i18nNode(root); return; }
  if (root.nodeType !== 1) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(n => {
    const p = n.parentElement;
    if (p && p.tagName === 'OPTION' && !p.hasAttribute('value')) p.setAttribute('value', n.nodeValue);
    i18nNode(n);
  });
  i18nAttrs(root);
  root.querySelectorAll('[placeholder],[aria-label],[title]').forEach(i18nAttrs);
}
if (LANG === 'en'){
  const i18nObs = new MutationObserver(muts => {
    for (const m of muts){
      if (m.type === 'characterData') i18nNode(m.target);
      (m.addedNodes || []).forEach(n => i18nApply(n));
    }
  });
  const i18nStart = () => { document.title = 'AddaBook — everyday adda with friends'; document.documentElement.lang = 'en'; i18nApply(document.body); i18nObs.observe(document.body, { childList: true, subtree: true, characterData: true }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', i18nStart);
  else i18nStart();
}

/* ---------- ICONS ---------- */
const I = {
  search:'<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  bell:'<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/></svg>',
  msg:'<svg viewBox="0 0 24 24"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5z"/></svg>',
  home:'<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  users:'<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/><path d="M16 5a3.5 3.5 0 0 1 0 6.5M18.5 15.4c1.7.7 2.7 2.1 3.1 4.1"/></svg>',
  fire:'<svg viewBox="0 0 24 24"><path d="M12 3c1 3-2 4.5-2 7a4.5 4.5 0 0 0 9 0c0-2-1-3.5-2-5-.3 1.2-1 2-2 2.5C14.5 6 13.5 4.5 12 3z"/><path d="M12 21a6.5 6.5 0 0 1-6.5-6.5c0-1.5.5-2.8 1.3-4 .5 1 1.2 1.7 2.2 2.2C8.7 14 9 15.5 10 16.5c-.3-2.3.8-3.7 2-5.5 1.2 1.8 3.5 3.3 3.5 6A6.5 6.5 0 0 1 12 21z" transform="scale(0.92) translate(1,0)"/></svg>',
  user:'<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.2-6 8-6s7 2 8 6"/></svg>',
  heart:'<svg viewBox="0 0 24 24"><path d="M12 20.5C7 16.5 3 13.3 3 9.3A4.8 4.8 0 0 1 12 6a4.8 4.8 0 0 1 9 3.3c0 4-4 7.2-9 11.2z"/></svg>',
  comment:'<svg viewBox="0 0 24 24"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5z"/></svg>',
  share:'<svg viewBox="0 0 24 24"><path d="M13 5.5 20 12l-7 6.5v-4C7 14.5 4.5 17 3 19c0-6 3.5-10 10-11z"/></svg>',
  bookmark:'<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  dots:'<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  img:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 3 3 3-3 5 5"/></svg>',
  send:'<svg viewBox="0 0 24 24"><path d="M22 2 11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  camera:'<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  video:'<svg viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
  grid:'<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
  chart:'<svg viewBox="0 0 24 24"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>',
  calendar:'<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  file:'<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>',
  bag:'<svg viewBox="0 0 24 24"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
  hand:'<svg viewBox="0 0 24 24"><path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/></svg>',
  eye:'<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff:'<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.6 10.6 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.5 9.5 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>',
  gift:'<svg viewBox="0 0 24 24"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>',
  link:'<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  qr:'<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14.5 14.5h2v2h-2z"/><path d="M21 15v2M15 21h2M18.5 18.5H21V21"/></svg>',
  moon:'<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  globe:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  shield:'<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  key:'<svg viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
  target:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
  ban:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M4.9 4.9l14.2 14.2"/></svg>',
  info:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  logout:'<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><path d="M21 12H9"/></svg>',
  power:'<svg viewBox="0 0 24 24"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 2v10"/></svg>',
  download:'<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><path d="M12 15V3"/></svg>',
  wallet:'<svg viewBox="0 0 24 24"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>',
  palette:'<svg viewBox="0 0 24 24"><circle cx="13.5" cy="6.5" r=".8"/><circle cx="17.5" cy="10.5" r=".8"/><circle cx="8.5" cy="7.5" r=".8"/><circle cx="6.5" cy="12.5" r=".8"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1a1.6 1.6 0 0 1 1.7-1.7h2c3 0 5.5-2.5 5.5-5.5C22 6 17.5 2 12 2z"/></svg>',
  gear:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  clock:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  sparkles:'<svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.8 5.8 1.9-5.8 1.9L12 18.4l-1.9-5.8L4.3 10.7l5.8-1.9z"/><path d="M19 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>',
  droplet:'<svg viewBox="0 0 24 24"><path d="M12 2.7 6.7 8.5a7.5 7.5 0 1 0 10.6 0z"/></svg>',
  briefcase:'<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
  smile:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/></svg>',
  mic:'<svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v4M8 23h8"/></svg>',
  archive:'<svg viewBox="0 0 24 24"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><path d="M10 12h4"/></svg>',
  check:'<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>',
  x:'<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  edit:'<svg viewBox="0 0 24 24"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
  pin:'<svg viewBox="0 0 24 24"><path d="M8 3h8v6l2.5 4h-13L8 9z"/><path d="M12 13v8"/></svg>',
  pinLoc:'<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-5.6-6.5-10.3a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="10.8" r="2.3"/></svg>',
  trash:'<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/></svg>',
  flag:'<svg viewBox="0 0 24 24"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/></svg>',
  volume:'<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
  rocket:'<svg viewBox="0 0 24 24"><path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1z"/><path d="M12 15l-3-3a22 22 0 0 1 2-4A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22 22 0 0 1-4 2z"/><path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0"/><path d="M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5"/></svg>',
  star:'<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  starF:'<svg viewBox="0 0 24 24"><path fill="currentColor" stroke="none" d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/></svg>',
  heartF:'<svg viewBox="0 0 24 24"><path fill="currentColor" stroke="none" d="M12 20.5C7 16.6 3 13.4 3 9.4 3 6.4 5.4 4 8.4 4c1.5 0 2.9.7 3.6 1.7C12.7 4.7 14.1 4 15.6 4 18.6 4 21 6.4 21 9.4c0 4-4 7.2-9 11.1z"/></svg>',
  trophy:'<svg viewBox="0 0 24 24"><path d="M8 21h8M12 17v4"/><path d="M7 4h10v6a5 5 0 0 1-10 0z"/><path d="M7 6H4a1 1 0 0 0-1 1c0 2 1.6 3.5 4 3.5M17 6h3a1 1 0 0 1 1 1c0 2-1.6 3.5-4 3.5"/></svg>',
  book:'<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  utensils:'<svg viewBox="0 0 24 24"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/></svg>',
  map:'<svg viewBox="0 0 24 24"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><path d="M8 2v16M16 6v16"/></svg>',
  landmark:'<svg viewBox="0 0 24 24"><path d="M3 21h18"/><path d="M5 21v-9M9.5 21v-9M14.5 21v-9M19 21v-9"/><path d="M2 12l10-6.5L22 12z"/></svg>',
  idCard:'<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5.5 16c.4-1.3 1.3-2 2.5-2s2.1.7 2.5 2"/><path d="M14.5 9.5H18M14.5 13H18"/></svg>',
  grad:'<svg viewBox="0 0 24 24"><path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-3.5"/><path d="M22 10v6"/></svg>',
  car:'<svg viewBox="0 0 24 24"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.5 2.8A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></svg>',
  bulb:'<svg viewBox="0 0 24 24"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>',
  music:'<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  ball:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 7.5 15 9.7l-1.2 3.6h-3.6L9 9.7z"/><path d="M12 2.2v5.3M20.6 7.4 15 9.7M21.8 15.4l-5.9-2.1M15.9 21.4l-2.1-5.5M8.1 21.4l2.1-5.5M2.2 15.4l5.9-2.1M3.4 7.4 9 9.7"/></svg>',
  code:'<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  folder:'<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  lock:'<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  gem:'<svg viewBox="0 0 24 24"><path d="M6 3h12l4 6-10 13L2 9z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>',
  sprout:'<svg viewBox="0 0 24 24"><path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/></svg>',
  paw:'<svg viewBox="0 0 24 24"><ellipse cx="12" cy="15.8" rx="4.1" ry="3.3" fill="currentColor" stroke="none"/><ellipse cx="4.9" cy="11" rx="1.8" ry="2.2" fill="currentColor" stroke="none"/><ellipse cx="8.6" cy="7.6" rx="1.8" ry="2.3" fill="currentColor" stroke="none"/><ellipse cx="13" cy="7.2" rx="1.8" ry="2.3" fill="currentColor" stroke="none"/><ellipse cx="17.2" cy="9.6" rx="1.8" ry="2.2" fill="currentColor" stroke="none"/></svg>',
  type:'<svg viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><path d="M9 20h6M12 4v16"/></svg>',
  wifi:'<svg viewBox="0 0 24 24"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><path d="M12 20h.01"/></svg>',
  clip:'<svg viewBox="0 0 24 24"><path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 1 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  mute:'<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M23 9l-6 6M17 9l6 6"/></svg>',
  help:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>'
};

/* sized inline icon for buttons/menus outside the .icb/.nav/.acts CSS scopes */
const ic = (n, s = 17) => (I[n] || '').replace('<svg ', `<svg width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-3.5px;flex:none" `);


/* ---------- SHELL ---------- */
function renderShell(){
  $('#topbar').innerHTML = `<div class="top">
    <div class="logo">আড্ডা<em>Book</em></div>
    <div class="ic">
      <button class="icb" onclick="go('search')" aria-label="খোঁজো">${I.search}</button>
      <button class="icb" onclick="go('notifs')" aria-label="নোটিফিকেশন">${I.bell}${unreadNotifs ? `<span class="dotn">${bn(unreadNotifs)}</span>` : ''}</button>
      <button class="icb" onclick="go('chat')" aria-label="চ্যাট">${I.msg}</button>
    </div></div>`;
  const EN = LANG === 'en';
  const kid = localStorage.getItem('adda-kid') === '1';
  const mid = kid ? ['trending', EN ? 'Explore' : 'আবিষ্কার', I.fire] : ['dating', EN ? 'Dating' : 'মনের মানুষ', I.heart];
  const items = EN ? [['feed','Home',I.home],['friends','Friends',I.users],mid,['chat','Chat',I.msg],['profile','Profile',I.user]]
                   : [['feed','হোম',I.home],['friends','বন্ধু',I.users],mid,['chat','চ্যাট',I.msg],['profile','প্রোফাইল',I.user]];
  $('#navbar').innerHTML = `<div class="nav">${items.map(([k,t,ic]) => `<button class="${curView === k ? 'on' : ''}" onclick="go('${k}')">${ic}${t}</button>`).join('')}</div>`;
}
function go(v, arg){
  curView = v; activeChat = null;
  if (chatChannel) { sb.removeChannel(chatChannel); chatChannel = null; }
  if (typingChannel) { sb.removeChannel(typingChannel); typingChannel = null; }
  renderShell();
  window.scrollTo(0, 0);
  ({ feed: renderFeed, friends: renderFriends, trending: renderTrending, chat: renderChatList,
     profile: () => renderProfile(me.id), notifs: renderNotifs, search: renderSearch,
     tokens: renderTokens, dating: renderDating, groups: renderGroups, saved: renderSaved, settings: renderSettings,
     quiz: renderQuiz, leaderboard: renderLeaderboard, achieve: renderAchievements, creator: renderCreator,
     albums: renderAlbums, pages: renderPages, events: renderEvents, service: renderService, market: renderMarket,
     gov: renderGov, habits: renderHabits, pets: renderPets, anon: renderAnon, closefriends: renderCloseFriends,
     archived: renderArchived, themes: renderThemes, videos: renderVideos, viewers: renderViewers, admin: renderAdmin }[v] || renderFeed)(arg);
}

/* ---------- AUTH ---------- */
function renderAuth(mode = 'login'){
  $('#topbar').innerHTML = ''; $('#navbar').innerHTML = '';
  view().innerHTML = `<div class="view">
    <div class="hero"><div class="mark">অ</div>
      <div style="font-size:25px;font-weight:800;position:relative;z-index:1">আড্ডাBook</div>
      <p style="font-size:13.5px;opacity:.88;margin-top:5px;position:relative;z-index:1">বন্ধুদের সাথে প্রতিদিনের আড্ডা, এক জায়গায়</p></div>
    <div class="loginbox">
      ${mode === 'signup' ? '<input class="field" id="authName" placeholder="তোমার নাম">' : ''}
      <input class="field" id="authEmail" type="email" placeholder="ইমেইল">
      <input class="field" id="authPass" type="password" placeholder="পাসওয়ার্ড (কমপক্ষে ৬ অক্ষর)">
      <div id="authErr" style="color:var(--danger);font-size:13px;margin-bottom:10px"></div>
      ${mode === 'login'
        ? `<button class="btn block" onclick="doLogin()">লগ ইন</button>
           <p style="text-align:center;margin-top:15px;font-size:13.5px;color:var(--mut)">অ্যাকাউন্ট নেই? <a href="#" onclick="renderAuth('signup');return false"><b>নতুন অ্যাকাউন্ট খোলো</b></a></p>`
        : `<button class="btn block" onclick="doSignup()">অ্যাকাউন্ট খোলো</button>
           <p style="text-align:center;margin-top:15px;font-size:13.5px;color:var(--mut)">আগে থেকেই অ্যাকাউন্ট আছে? <a href="#" onclick="renderAuth('login');return false"><b>লগ ইন করো</b></a></p>`}
    </div>
    <p style="text-align:center;color:var(--faint);font-size:11.5px;padding:18px 0 6px">© 2026 আড্ডাBook · LIMON Labs</p></div>`;
}
async function doSignup(){
  const name = $('#authName').value.trim(), email = $('#authEmail').value.trim(), pass = $('#authPass').value;
  const err = $('#authErr');
  if (!name || !email || pass.length < 6) { err.textContent = 'নাম, ইমেইল আর কমপক্ষে ৬ অক্ষরের পাসওয়ার্ড দাও'; return; }
  const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { name } } });
  if (error) { err.textContent = 'হয়নি: ' + error.message; return; }
  if (!data.session) { err.style.color = 'var(--ok)'; err.textContent = 'অ্যাকাউন্ট তৈরি! ইমেইলে পাঠানো লিংকে চাপ দিয়ে নিশ্চিত করে তারপর লগ ইন করো।'; return; }
  await boot();
}
async function doLogin(){
  const email = $('#authEmail').value.trim(), pass = $('#authPass').value;
  const err = $('#authErr');
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  if (error) { err.textContent = 'লগ ইন হয়নি — ইমেইল/পাসওয়ার্ড মিলিয়ে আবার চেষ্টা করো'; return; }
  await boot();
}
async function doLogout(){ await sb.auth.signOut(); me = null; renderAuth(); }

/* ---------- V2: HELPERS ---------- */
let breakTimer = null;
function startBreakReminder(){
  if (breakTimer) clearInterval(breakTimer);
  breakTimer = setInterval(() => { toast('⏰ অনেকক্ষণ ধরে আছো — একটু চোখ আর মনকে বিশ্রাম দাও'); }, 30 * 60 * 1000);
}
async function downloadMyData(){
  toast('তোমার ডেটা তৈরি হচ্ছে...');
  const [profile, posts, comments, likes, txns] = await Promise.all([
    sb.from('profiles').select('*').eq('id', me.id).single(),
    sb.from('posts').select('*').eq('user_id', me.id),
    sb.from('comments').select('*').eq('user_id', me.id),
    sb.from('likes').select('*').eq('user_id', me.id),
    sb.from('token_txns').select('*').eq('user_id', me.id)
  ]);
  const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), profile: profile.data, posts: posts.data, comments: comments.data, likes: likes.data, token_history: txns.data }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'addabook-my-data.json'; a.click();
  toast('ডেটা ডাউনলোড হয়েছে 📥');
}
async function renderArchived(){
  curView = 'archived'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px;font-size:18px;font-weight:800">${ic('archive', 19)} আর্কাইভ করা পোস্ট</div><div id="archList"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const posts = await fetchPosts({ authorId: me.id, archivedOnly: true });
  const el = document.getElementById('archList');
  if (el) el.innerHTML = posts.length ? posts.map(postCard).join('') : '<div class="card empty">আর্কাইভে কিছু নেই</div>';
}
async function renderVideos(){
  toast('এই অংশটা আপাতত বন্ধ আছে'); go('feed'); return;
  curView = 'videos'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('video', 19)} ভিডিও</div><div id="vidList"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data } = await sb.from('posts').select('*').not('video_url', 'is', null).neq('video_url', '').order('created_at', { ascending: false }).limit(30);
  const posts = data && data.length ? await fetchPostsByIds(data) : [];
  const el = document.getElementById('vidList');
  if (el) el.innerHTML = posts.length ? posts.map(postCard).join('') : '<div class="card empty">এখনো কোনো ভিডিও পোস্ট নেই — পোস্ট করার সময় ভিডিও যোগ করো</div>';
}

/* ---------- V2: QUIZ / LEADERBOARD / ACHIEVEMENTS / CREATOR ---------- */
const QUIZ_BANK = [
  { q: 'বাংলাদেশের জাতীয় ফল কোনটি?', o: ['আম', 'কাঁঠাল', 'লিচু', 'কলা'], a: 1 },
  { q: 'ঢাকা কোন নদীর তীরে অবস্থিত?', o: ['পদ্মা', 'যমুনা', 'বুড়িগঙ্গা', 'মেঘনা'], a: 2 },
  { q: 'বাংলা নববর্ষ কোন তারিখে পালিত হয়?', o: ['১৪ এপ্রিল', '২১ ফেব্রুয়ারি', '১৬ ডিসেম্বর', '২৬ মার্চ'], a: 0 },
  { q: 'জাতীয় সংগীতের রচয়িতা কে?', o: ['কাজী নজরুল ইসলাম', 'রবীন্দ্রনাথ ঠাকুর', 'জসীমউদ্দীন', 'সুকান্ত ভট্টাচার্য'], a: 1 },
  { q: 'পৃথিবীর সবচেয়ে বড় মহাসাগর কোনটি?', o: ['আটলান্টিক', 'ভারত', 'প্রশান্ত', 'উত্তর মেরু'], a: 2 },
  { q: 'মানুষের শরীরে হাড়ের সংখ্যা কত (প্রাপ্তবয়স্ক)?', o: ['২০৬', '২২৬', '১৯৬', '২৫৬'], a: 0 },
  { q: 'বাংলাদেশের মুদ্রার নাম কী?', o: ['রুপি', 'টাকা', 'দিনার', 'ডলার'], a: 1 },
  { q: 'সূর্যের সবচেয়ে কাছের গ্রহ কোনটি?', o: ['শুক্র', 'মঙ্গল', 'বুধ', 'পৃথিবী'], a: 2 },
  { q: 'কম্পিউটারের জনক কাকে বলা হয়?', o: ['বিল গেটস', 'চার্লস ব্যাবেজ', 'অ্যালান টুরিং', 'স্টিভ জবস'], a: 1 },
  { q: 'বিশ্বের দীর্ঘতম নদী কোনটি?', o: ['আমাজন', 'নীল', 'ইয়াংসিকিয়াং', 'মিসিসিপি'], a: 1 },
  { q: 'বাংলাদেশের জাতীয় মাছ কোনটি?', o: ['রুই', 'কাতলা', 'ইলিশ', 'পাঙ্গাস'], a: 2 },
  { q: 'আলো বছরে কত দূরত্ব অতিক্রম করে (আনুমানিক)?', o: ['৯.৫ লক্ষ কোটি কিমি', '১৫ কোটি কিমি', '৩ লক্ষ কিমি', '১০০ কোটি কিমি'], a: 0 }
];
async function renderQuiz(){
  toast('কুইজ আপাতত বন্ধ আছে'); go('feed'); return;
  curView = 'quiz'; renderShell();
  const day = Math.floor(Date.now() / 864e5);
  const item = QUIZ_BANK[day % QUIZ_BANK.length];
  const doneKey = 'adda-quiz-' + day;
  const done = localStorage.getItem(doneKey);
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('help', 19)} আজকের কুইজ</div>
    <div class="card"><p style="font-size:15.5px;line-height:1.6"><b>${esc(item.q)}</b></p>
    <div id="quizOpts" style="display:grid;gap:8px;margin-top:12px">${item.o.map((o, i) => `<button class="btn ghost" style="justify-content:flex-start" onclick="answerQuiz(${i},'${doneKey}')">${esc(o)}</button>`).join('')}</div>
    <p id="quizMsg" style="margin-top:12px;font-size:13.5px;color:var(--mut)">${done ? 'আজকের কুইজ তুমি খেলে ফেলেছ — কাল আবার এসো! সঠিক উত্তরে পাওয়া যায় ৩০ টোকেন।' : 'সঠিক উত্তর দিলে পাবে ৩০ টোকেন 🎉 (দিনে একবার)'}</p></div></div>`;
}
async function answerQuiz(idx, doneKey){
  if (localStorage.getItem(doneKey)) { toast('আজকের কুইজ হয়ে গেছে'); return; }
  const day = Math.floor(Date.now() / 864e5);
  const item = QUIZ_BANK[day % QUIZ_BANK.length];
  localStorage.setItem(doneKey, '1');
  const msg = document.getElementById('quizMsg');
  if (idx === item.a) {
    const { data } = await sb.rpc('rpc_award', { p_reason: 'quiz' });
    if (typeof data === 'number') me.tokens = data;
    if (msg) msg.innerHTML = '🎉 <b>সঠিক উত্তর!</b> ৩০ টোকেন যোগ হয়েছে।';
    toast('সঠিক! +৩০ টোকেন 🎉');
  } else {
    if (msg) msg.innerHTML = `দুঃখিত, সঠিক উত্তর ছিল: <b>${esc(item.o[item.a])}</b> — কাল আবার চেষ্টা করো!`;
  }
}
async function renderLeaderboard(){
  toast('এই অংশটা আপাতত বন্ধ আছে'); go('feed'); return;
  curView = 'leaderboard'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('trophy', 19)} লিডারবোর্ড (টোকেন)</div><div class="card" id="lbList" style="padding:6px 15px"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data } = await sb.from('profiles').select('*').order('tokens', { ascending: false }).limit(20);
  (data || []).forEach(p => profilesCache[p.id] = p);
  const el = document.getElementById('lbList');
  if (el) el.innerHTML = (data || []).map((p, i) => `<div class="row">${'<b style="width:26px;text-align:center">' + (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : bn(i + 1)) + '</b>'}${avatar(p, 38, 14)}<div style="flex:1"><b>${esc(p.name)}</b>${badges(p)}</div><b style="color:var(--acc)">${bn(p.tokens)}</b></div>`).join('');
}
async function renderAchievements(){
  toast('এই অংশটা আপাতত বন্ধ আছে'); go('feed'); return;
  curView = 'achieve'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('trophy', 19)} তোমার অর্জন</div><div id="achList"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const [posts, likesGot] = await Promise.all([
    sb.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', me.id),
    sb.from('posts').select('id').eq('user_id', me.id).limit(200)
  ]);
  let likeCount = 0;
  if (likesGot.data && likesGot.data.length) {
    const { count } = await sb.from('likes').select('id', { count: 'exact', head: true }).in('post_id', likesGot.data.map(p => p.id));
    likeCount = count || 0;
  }
  const items = [
    ['edit', 'প্রথম পোস্ট', (posts.count || 0) >= 1], ['book', 'লেখক — ১০টি পোস্ট', (posts.count || 0) >= 10],
    ['heart', 'ভালোবাসা পেয়েছ — ২৫ লাইক', likeCount >= 25], ['fire', '৭ দিনের স্ট্রিক', (me.login_streak || 0) >= 7],
    ['users', 'বন্ধু মহল — ১০ বন্ধু', friendIds.size >= 10], ['gem', 'ধনী — ৫০০ টোকেন', (me.tokens || 0) >= 500],
    ['comment', 'আড্ডাবাজ — মন্তব্যে সক্রিয়', true]
  ];
  const el = document.getElementById('achList');
  if (el) el.innerHTML = `<div class="card" style="padding:6px 15px">${items.map(([icn, t, got]) => `<div class="earn" style="opacity:${got ? 1 : 0.45}"><span class="eic">${ic(icn, 20)}</span><div><b>${t}</b></div><span style="display:inline-flex">${got ? ic('check', 16) : ic('lock', 16)}</span></div>`).join('')}</div>`;
}
async function renderCreator(){
  curView = 'creator'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('chart', 19)} ক্রিয়েটর ড্যাশবোর্ড</div><div id="creBody"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data: myPosts } = await sb.from('posts').select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(100);
  const posts = myPosts && myPosts.length ? await fetchPostsByIds(myPosts) : [];
  const totalLikes = posts.reduce((s, p) => s + (p._likes || 0), 0);
  const totalComments = posts.reduce((s, p) => s + (p._comments || 0), 0);
  const weekAgo = Date.now() - 7 * 864e5;
  const weekPosts = posts.filter(p => new Date(p.created_at).getTime() > weekAgo);
  const top = [...posts].sort((a, b) => (b._likes || 0) - (a._likes || 0))[0];
  const { count: followers } = await sb.from('follows').select('follower', { count: 'exact', head: true }).eq('following', me.id);
  const { count: viewsCount } = await sb.from('profile_views').select('viewer', { count: 'exact', head: true }).eq('profile', me.id);
  const el = document.getElementById('creBody');
  if (el) el.innerHTML = `
    <div class="stats" style="margin:12px"><div><b>${bn(posts.length)}</b><small>মোট পোস্ট</small></div><div><b>${bn(totalLikes)}</b><small>মোট লাইক</small></div><div><b>${bn(totalComments)}</b><small>মোট মন্তব্য</small></div></div>
    <div class="stats" style="margin:0 12px"><div><b>${bn(followers || 0)}</b><small>ফলোয়ার</small></div><div><b>${bn(viewsCount || 0)}</b><small>প্রোফাইল ভিউ</small></div><div><b>${ic('fire', 15)} ${bn(me.login_streak || 0)}</b><small>দিনের স্ট্রিক</small></div></div>
    <div class="seclabel">${ic('calendar', 15)} সাপ্তাহিক রিপোর্ট (গত ৭ দিন)</div>
    <div class="card"><p style="font-size:14px;line-height:1.7">এই সপ্তাহে তুমি <b>${bn(weekPosts.length)}টি</b> পোস্ট করেছ। মোট লাইক <b>${bn(totalLikes)}</b>, মন্তব্য <b>${bn(totalComments)}</b>। ${weekPosts.length ? 'দারুণ চলছে — এভাবেই চালিয়ে যাও! 🎉' : 'এই সপ্তাহে একটা পোস্ট করে শুরু করো!'}</p></div>
    ${top ? `<div class="seclabel">${ic('trophy', 15)} তোমার সেরা পোস্ট</div>` + postCard(top) : ''}`;
}

/* ---------- V2: ALBUMS / PAGES / EVENTS ---------- */
async function renderAlbums(uid = null){
  curView = 'albums'; renderShell();
  const owner = uid || me.id;
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('img', 19)} ছবির অ্যালবাম</div>
    ${owner === me.id ? `<div style="padding:12px 12px 0"><button class="btn block" onclick="createAlbumSheet()">+ নতুন অ্যালবাম</button></div>` : ''}
    <div id="albumList" style="padding:12px"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data } = await sb.from('albums').select('*').eq('user_id', owner).order('created_at', { ascending: false });
  const el = document.getElementById('albumList');
  if (el) el.innerHTML = (data || []).length ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${data.map(a => `<button class="card" style="margin:0;text-align:left;cursor:pointer" onclick="openAlbum('${a.id}')"><b>${ic('folder', 15)} ${esc(a.name)}</b><br><small style="color:var(--mut)">${timeAgo(a.created_at)}</small></button>`).join('')}</div>` : '<div class="card empty">কোনো অ্যালবাম নেই</div>';
}
function createAlbumSheet(){
  sheet(`<h3>নতুন অ্যালবাম</h3><input class="field" id="albTitle" placeholder="অ্যালবামের নাম (যেমন: কক্সবাজার ভ্রমণ)"><button class="btn block" onclick="createAlbum()">বানাও</button>`);
}
async function createAlbum(){
  const title = document.getElementById('albTitle').value.trim(); if (!title) return;
  const { error } = await sb.from('albums').insert({ user_id: me.id, name: title });
  if (error) { toast('হয়নি'); return; }
  closeSheet(); toast('অ্যালবাম তৈরি ✓'); renderAlbums();
}
async function openAlbum(albumId){
  const { data: album } = await sb.from('albums').select('*').eq('id', albumId).single();
  const { data: photos } = await sb.from('album_photos').select('*').eq('album_id', albumId).order('created_at');
  sheet(`<h3>${ic('folder', 18)} ${esc(album ? album.name : 'অ্যালবাম')}</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${(photos || []).map(ph => `<img src="${esc(ph.image_url)}" style="width:100%;border-radius:10px;aspect-ratio:1;object-fit:cover">`).join('') || '<p style="color:var(--mut);font-size:13.5px">এখনো ছবি নেই</p>'}</div>
    ${album && album.user_id === me.id ? `<label class="btn block" style="margin-top:12px;cursor:pointer">+ ছবি যোগ করো<input type="file" accept="image/*" style="display:none" onchange="addAlbumPhoto('${albumId}',this)"></label>` : ''}`);
}
async function addAlbumPhoto(albumId, input){
  const f = input.files[0]; if (!f) return;
  const url = await uploadImage(f);
  if (!url) { toast('আপলোড হয়নি'); return; }
  await sb.from('album_photos').insert({ album_id: albumId, image_url: url });
  openAlbum(albumId);
}
async function renderPages(){
  curView = 'pages'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('file', 19)} পেজ</div>
    <div style="padding:12px 12px 0"><button class="btn block" onclick="createPageSheet()">+ নতুন পেজ বানাও</button></div>
    <div class="card" id="pageList" style="padding:6px 15px"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data } = await sb.from('pages').select('*').order('created_at', { ascending: false }).limit(40);
  (data || []).forEach(pg => pagesCache[pg.id] = pg);
  const el = document.getElementById('pageList');
  if (el) el.innerHTML = (data || []).length ? data.map(pg => `<div class="row">${avatar(pg, 42, 15)}<div style="flex:1"><b>${esc(pg.name)}</b><small style="display:block;color:var(--faint)">${esc(pg.category || 'সাধারণ')}</small></div><button class="btn sm" onclick="renderPageDetail('${pg.id}')">খোলো</button></div>`).join('') : '<div class="empty">এখনো কোনো পেজ নেই</div>';
}
function createPageSheet(){
  sheet(`<h3>নতুন পেজ</h3><input class="field" id="pgName" placeholder="পেজের নাম"><input class="field" id="pgCat" placeholder="ধরন (যেমন: ব্যবসা, কমিউনিটি, ব্লগ)"><textarea class="field" id="pgAbout" placeholder="পেজ সম্পর্কে"></textarea><button class="btn block" onclick="createPage()">পেজ বানাও</button>`);
}
async function createPage(){
  const name = document.getElementById('pgName').value.trim(); if (!name) { toast('নাম দাও'); return; }
  const { error } = await sb.from('pages').insert({ created_by: me.id, name, category: document.getElementById('pgCat').value.trim(), about: document.getElementById('pgAbout').value.trim() });
  if (error) { toast('হয়নি'); return; }
  closeSheet(); toast('পেজ তৈরি ✓'); renderPages();
}
async function renderPageDetail(pageId){
  curView = 'pages'; renderShell();
  const { data: pg } = await sb.from('pages').select('*').eq('id', pageId).single();
  if (!pg) { renderPages(); return; }
  pagesCache[pg.id] = pg;
  const { data: follows } = await sb.from('page_follows').select('user_id').eq('page_id', pageId);
  const iFollow = (follows || []).some(f => f.user_id === me.id);
  view().innerHTML = `<div class="view">
    <div class="cover"></div><div class="prof"><div class="big">${pg.avatar_url ? `<img src="${esc(pg.avatar_url)}">` : ic('file', 36)}</div>
    <div style="font-size:19px;font-weight:800">${esc(pg.name)}</div>
    <p style="color:var(--mut);font-size:13px">${esc(pg.category || '')} · ${bn((follows || []).length)} ফলোয়ার</p>
    ${pg.about ? `<p style="font-size:13.5px;margin-top:6px">${esc(pg.about)}</p>` : ''}
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:center">
      <button class="btn ${iFollow ? 'ghost' : ''}" onclick="togglePageFollow('${pageId}',${iFollow})">${iFollow ? 'ফলো করছ ✓' : 'ফলো করো'}</button>
      ${pg.created_by === me.id ? `<button class="btn" onclick="openComposer(null,'${pageId}')">পেজে পোস্ট করো</button>` : ''}
    </div></div>
    <div class="seclabel">পেজের পোস্ট</div><div id="pagePosts"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data: raw } = await sb.from('posts').select('*').eq('page_id', pageId).order('created_at', { ascending: false }).limit(30);
  const posts = raw && raw.length ? await fetchPostsByIds(raw) : [];
  const el = document.getElementById('pagePosts');
  if (el) el.innerHTML = posts.length ? posts.map(postCard).join('') : '<div class="card empty">এই পেজে এখনো পোস্ট নেই</div>';
}
async function togglePageFollow(pageId, following){
  if (following) await sb.from('page_follows').delete().eq('page_id', pageId).eq('user_id', me.id);
  else await sb.from('page_follows').insert({ page_id: pageId, user_id: me.id });
  renderPageDetail(pageId);
}
async function renderEvents(){
  curView = 'events'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('calendar', 19)} ইভেন্ট</div>
    <div style="padding:12px 12px 0"><button class="btn block" onclick="createEventSheet()">+ নতুন ইভেন্ট</button></div>
    <div id="eventList" style="padding:12px"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data } = await sb.from('events').select('*').gte('starts_at', new Date(Date.now() - 864e5).toISOString()).order('starts_at').limit(40);
  const ids = (data || []).map(e => e.id);
  const { data: rsvps } = ids.length ? await sb.from('event_rsvps').select('*').in('event_id', ids) : { data: [] };
  await cacheProfiles((data || []).map(e => e.created_by));
  const el = document.getElementById('eventList');
  if (el) el.innerHTML = (data || []).length ? data.map(e => {
    const going = (rsvps || []).filter(r => r.event_id === e.id);
    const mine = going.some(r => r.user_id === me.id);
    return `<div class="card"><b style="font-size:15.5px">🎉 ${esc(e.title)}</b><br><small style="color:var(--mut)">🗓 ${new Date(e.starts_at).toLocaleString(LANG === 'en' ? 'en-US' : 'bn-BD')} ${e.place ? '· 📍 ' + esc(e.place) : ''}</small>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center"><button class="btn ${mine ? 'ghost' : ''} sm" onclick="toggleRsvp('${e.id}',${mine})">${mine ? 'যাচ্ছ ✓' : 'আমি যাব'}</button><small style="color:var(--mut)">${bn(going.length)} জন যাচ্ছে · আয়োজক: ${esc(prof(e.created_by).name)}</small></div></div>`;
  }).join('') : '<div class="card empty">সামনে কোনো ইভেন্ট নেই — তুমিই একটা বানাও!</div>';
}
function createEventSheet(){
  sheet(`<h3>নতুন ইভেন্ট</h3><input class="field" id="evTitle" placeholder="ইভেন্টের নাম"><input class="field" type="datetime-local" id="evWhen"><input class="field" id="evPlace" placeholder="জায়গা"><button class="btn block" onclick="createEvent()">ইভেন্ট বানাও</button>`);
}
async function createEvent(){
  const title = document.getElementById('evTitle').value.trim();
  const when = document.getElementById('evWhen').value;
  if (!title || !when) { toast('নাম আর সময় দাও'); return; }
  const { error } = await sb.from('events').insert({ created_by: me.id, title, starts_at: new Date(when).toISOString(), place: document.getElementById('evPlace').value.trim() });
  if (error) { toast('হয়নি'); return; }
  closeSheet(); toast('ইভেন্ট তৈরি ✓'); renderEvents();
}
async function toggleRsvp(eventId, going){
  if (going) await sb.from('event_rsvps').delete().eq('event_id', eventId).eq('user_id', me.id);
  else await sb.from('event_rsvps').insert({ event_id: eventId, user_id: me.id });
  renderEvents();
}

/* ---------- V2: SERVICE BOARD / MARKET / GOV ---------- */
let serviceTab = 'blood';
async function renderService(tab = 'blood'){
  curView = 'service'; serviceTab = tab; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('hand', 19)} সেবা বোর্ড</div>
    <div class="seg"><button class="${tab === 'blood' ? 'on' : ''}" onclick="renderService('blood')">${ic('droplet', 15)} রক্ত</button><button class="${tab === 'lost' ? 'on' : ''}" onclick="renderService('lost')">${ic('search', 15)} হারানো-প্রাপ্তি</button><button class="${tab === 'jobs' ? 'on' : ''}" onclick="renderService('jobs')">${ic('briefcase', 15)} চাকরি</button></div>
    <div style="padding:0 12px"><button class="btn block" onclick="serviceAddSheet('${tab}')">+ নতুন পোস্ট দাও</button></div>
    <div id="svcList" style="padding:12px"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const table = tab === 'blood' ? 'blood_requests' : tab === 'lost' ? 'lost_items' : 'jobs';
  const { data } = await sb.from(table).select('*').order('created_at', { ascending: false }).limit(40);
  await cacheProfiles((data || []).map(r => r.user_id));
  const el = document.getElementById('svcList');
  if (!el) return;
  if (!(data || []).length) { el.innerHTML = '<div class="card empty">এখনো কিছু নেই</div>'; return; }
  el.innerHTML = data.map(r => {
    const a = prof(r.user_id);
    let main = '', sub = '';
    if (tab === 'blood') { main = `🩸 <b>${esc(r.blood_group)} রক্ত দরকার</b>`; sub = `${r.hospital ? '🏥 ' + esc(r.hospital) + ' · ' : ''}${r.area ? '📍 ' + esc(r.area) : ''}`; }
    if (tab === 'lost') { main = `${r.kind === 'found' ? '🎉 পাওয়া গেছে' : '🔍 হারিয়ে গেছে'}: <b>${esc(r.title)}</b>`; sub = `${r.area ? '📍 ' + esc(r.area) : ''}`; }
    if (tab === 'jobs') { main = `💼 <b>${esc(r.title)}</b>${r.company ? ' — ' + esc(r.company) : ''}`; sub = `${r.area ? '📍 ' + esc(r.area) : ''}`; }
    return `<div class="card"><div style="font-size:15px">${main}</div><small style="color:var(--mut);line-height:1.6">${sub}</small><div style="margin-top:7px"><button class="btn ghost sm" onclick="goProfile('${r.user_id}')">${esc(a.name)}</button> ${r.user_id !== me.id ? `<button class="btn sm" onclick="startChat('${r.user_id}')">মেসেজ</button>` : ''} <small style="color:var(--faint)">${timeAgo(r.created_at)}</small></div></div>`;
  }).join('');
}
function serviceAddSheet(tab){
  if (tab === 'blood') sheet(`<h3>${ic('droplet', 18)} রক্তের আবেদন</h3><input class="field" id="svGroup" placeholder="রক্তের গ্রুপ (যেমন: B+)"><input class="field" id="svHospital" placeholder="হাসপাতাল"><input class="field" id="svArea" placeholder="এলাকা"><button class="btn block" onclick="serviceAdd('blood')">পোস্ট করো</button>`);
  else if (tab === 'lost') sheet(`<h3>${ic('search', 18)} হারানো-প্রাপ্তি</h3><select class="field" id="svKind"><option value="lost">হারিয়ে গেছে</option><option value="found">পাওয়া গেছে</option></select><input class="field" id="svTitle" placeholder="কী জিনিস?"><input class="field" id="svArea" placeholder="কোন এলাকায়?"><button class="btn block" onclick="serviceAdd('lost')">পোস্ট করো</button>`);
  else sheet(`<h3>${ic('briefcase', 18)} চাকরির পোস্ট</h3><input class="field" id="svTitle" placeholder="পদের নাম"><input class="field" id="svCompany" placeholder="প্রতিষ্ঠান"><input class="field" id="svArea" placeholder="এলাকা"><button class="btn block" onclick="serviceAdd('jobs')">পোস্ট করো</button>`);
}
async function serviceAdd(tab){
  let row = { user_id: me.id }, table = '';
  if (tab === 'blood') { table = 'blood_requests'; row.blood_group = document.getElementById('svGroup').value.trim(); row.hospital = document.getElementById('svHospital').value.trim(); row.area = document.getElementById('svArea').value.trim(); if (!row.blood_group) { toast('রক্তের গ্রুপ দাও'); return; } }
  if (tab === 'lost') { table = 'lost_items'; row.kind = document.getElementById('svKind').value; row.title = document.getElementById('svTitle').value.trim(); row.area = document.getElementById('svArea').value.trim(); if (!row.title) { toast('জিনিসের নাম দাও'); return; } }
  if (tab === 'jobs') { table = 'jobs'; row.title = document.getElementById('svTitle').value.trim(); row.company = document.getElementById('svCompany').value.trim(); row.area = document.getElementById('svArea').value.trim(); if (!row.title) { toast('পদের নাম দাও'); return; } }
  const { error } = await sb.from(table).insert(row);
  if (error) { toast('হয়নি'); return; }
  closeSheet(); toast('পোস্ট হয়েছে ✓'); renderService(tab);
}
let marketCat = 'সব';
async function renderMarket(cat = 'সব'){
  curView = 'market'; marketCat = cat; renderShell();
  const cats = ['সব', 'বিক্রি', 'ফ্রি', 'সেবা', 'অফার', 'বই বিনিময়'];
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('bag', 19)} আড্ডা বাজার</div>
    <div style="display:flex;gap:6px;padding:12px 12px 0;flex-wrap:wrap">${cats.map(c => `<button class="btn ${c === cat ? '' : 'ghost'} sm" onclick="renderMarket('${c}')">${c}</button>`).join('')}</div>
    <div style="padding:12px 12px 0"><button class="btn block" onclick="listingSheet()">+ বিজ্ঞাপন দাও</button></div>
    <div id="mktList" style="padding:12px"><div class="empty">লোড হচ্ছে...</div></div>
    <p style="padding:0 16px 8px;font-size:12px;color:var(--mut)">⚠️ কেনাবেচায় নিজে যাচাই করে লেনদেন করো — অগ্রিম টাকা পাঠানোর আগে সাবধান।</p></div>`;
  let q = sb.from('listings').select('*').order('created_at', { ascending: false }).limit(40);
  if (cat !== 'সব') q = q.eq('category', cat);
  const { data } = await q;
  await cacheProfiles((data || []).map(r => r.user_id));
  const el = document.getElementById('mktList');
  if (el) el.innerHTML = (data || []).length ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${data.map(l => `<div class="card" style="margin:0">${l.image_url ? `<img src="${esc(l.image_url)}" style="width:100%;border-radius:10px;aspect-ratio:1.2;object-fit:cover">` : ''}<b style="font-size:14.5px">${esc(l.title)}</b><br><span class="pill">${esc(l.category)}</span> <b style="color:var(--acc)">${l.price ? '৳' + bn(l.price) : 'ফ্রি'}</b><br><small style="color:var(--mut)">${esc(prof(l.user_id).name)}</small><br>${l.user_id !== me.id ? `<button class="btn sm" style="margin-top:7px" onclick="startChat('${l.user_id}')">মেসেজ করো</button>` : `<button class="btn ghost sm" style="margin-top:7px" onclick="deleteListing('${l.id}')">মুছে ফেলো</button>`}</div>`).join('')}</div>` : '<div class="card empty">এই ক্যাটাগরিতে কিছু নেই</div>';
}
function listingSheet(){
  sheet(`<h3>${ic('bag', 18)} নতুন বিজ্ঞাপন</h3><input class="field" id="lsTitle" placeholder="জিনিসের নাম"><select class="field" id="lsCat"><option>বিক্রি</option><option>ফ্রি</option><option>সেবা</option><option>অফার</option><option>বই বিনিময়</option></select><input class="field" id="lsPrice" type="number" min="0" placeholder="দাম টাকায় (ফ্রি হলে ০ দাও)"><label style="font-size:13.5px;color:var(--mut)">ছবি <input type="file" id="lsImg" accept="image/*" style="font-size:12px"></label><button class="btn block" style="margin-top:10px" onclick="addListing()">বিজ্ঞাপন দাও</button>`);
}
async function addListing(){
  const title = document.getElementById('lsTitle').value.trim(); if (!title) { toast('নাম দাও'); return; }
  const f = document.getElementById('lsImg').files[0];
  const image_url = f ? await uploadImage(f) : '';
  const { error } = await sb.from('listings').insert({ user_id: me.id, title, category: document.getElementById('lsCat').value, price: parseInt(document.getElementById('lsPrice').value, 10) || 0, image_url });
  if (error) { toast('হয়নি'); return; }
  closeSheet(); toast('বিজ্ঞাপন দেওয়া হয়েছে ✓'); renderMarket('সব');
}
async function deleteListing(id){
  await sb.from('listings').delete().eq('id', id);
  toast('মোছা হয়েছে'); renderMarket(marketCat);
}
function renderGov(){
  curView = 'gov'; renderShell();
  const links = [
    ['landmark', 'জাতীয় পোর্টাল (সব সেবা এক জায়গায়)', 'https://bangladesh.gov.bd'],
    ['idCard', 'জাতীয় পরিচয়পত্র (NID) সেবা', 'https://services.nidw.gov.bd'],
    ['file', 'জন্ম নিবন্ধন', 'https://bdris.gov.bd'],
    ['globe', 'ই-পাসপোর্ট', 'https://www.epassport.gov.bd'],
    ['grad', 'শিক্ষা বোর্ডের ফলাফল', 'https://educationboardresults.gov.bd'],
    ['shield', 'বাংলাদেশ পুলিশ', 'https://www.police.gov.bd'],
    ['car', 'BRTA (ড্রাইভিং লাইসেন্স, গাড়ি)', 'https://www.brta.gov.bd'],
    ['bulb', 'বিদ্যুৎ বিল ও সেবা (DESCO)', 'https://desco.org.bd']
  ];
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('landmark', 19)} সরকারি সেবার লিংক</div>
    <p style="padding:8px 16px 0;font-size:13px;color:var(--mut)">সবগুলোই সরকারি অফিসিয়াল ওয়েবসাইট — লিংকে গিয়ে সরাসরি সেবা নাও।</p>
    <div class="card" style="padding:6px 15px">${links.map(([icn, t, u]) => `<a class="menu-item" style="display:flex;text-decoration:none;color:var(--ink)" href="${u}" target="_blank" rel="noopener">${ic(icn, 17)} ${t}<span style="margin-left:auto">↗</span></a>`).join('')}</div>
    <div style="padding:0 12px"><button class="btn ghost block" onclick="openTag('পড়াশোনা')">${ic('book', 15)} পড়াশোনা কর্নার</button></div>
    <div style="padding:8px 12px 0"><button class="btn ghost block" onclick="openTag('রেসিপি')">${ic('utensils', 15)} রেসিপি কর্নার</button></div>
    <div style="padding:8px 12px 0"><button class="btn ghost block" onclick="openTag('ভ্রমণ')">${ic('map', 15)} ভ্রমণ কর্নার</button></div></div>`;
}

/* ---------- V2: HABITS / PETS / ANON / CLOSE FRIENDS ---------- */
async function renderHabits(){
  toast('এই অংশটা আপাতত বন্ধ আছে'); go('feed'); return;
  curView = 'habits'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('sprout', 19)} অভ্যাস ট্র্যাকার</div>
    <div style="padding:12px 12px 0"><button class="btn block" onclick="habitSheet()">+ নতুন অভ্যাস</button></div>
    <div id="habitList" style="padding:12px"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data: habits } = await sb.from('habits').select('*').eq('user_id', me.id).order('created_at');
  const todayStr = new Date().toISOString().slice(0, 10);
  const { data: logs } = await sb.from('habit_logs').select('*').eq('user_id', me.id).gte('day', new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
  const el = document.getElementById('habitList');
  if (el) el.innerHTML = (habits || []).length ? habits.map(h => {
    const myLogs = (logs || []).filter(l => l.habit_id === h.id);
    const doneToday = myLogs.some(l => l.day === todayStr);
    let streak = 0; let d = new Date();
    if (!doneToday) d.setDate(d.getDate() - 1);
    const daySet = new Set(myLogs.map(l => l.day));
    while (daySet.has(d.toISOString().slice(0, 10))) { streak++; d.setDate(d.getDate() - 1); }
    return `<div class="card"><div style="display:flex;align-items:center;gap:10px"><span style="display:flex">${ic('sprout', 26)}</span><div style="flex:1"><b>${esc(h.name)}</b><br><small style="color:var(--mut)">🔥 ধারাবাহিকতা: ${bn(streak)} দিন · মোট ${bn(myLogs.length)} বার</small></div>${doneToday ? '<span class="pill">আজ হয়েছে ✓</span>' : `<button class="btn sm" onclick="logHabit('${h.id}')">আজ করলাম</button>`}</div></div>`;
  }).join('') : '<div class="card empty">এখনো কোনো অভ্যাস নেই — যেমন: বই পড়া, ব্যায়াম, নামাজ</div>';
}
function habitSheet(){
  sheet(`<h3>নতুন অভ্যাস</h3><input class="field" id="hbTitle" placeholder="অভ্যাসের নাম (যেমন: ১০ পৃষ্ঠা বই পড়া)"><button class="btn block" onclick="addHabit()">যোগ করো</button>`);
}
async function addHabit(){
  const title = document.getElementById('hbTitle').value.trim(); if (!title) return;
  const { error } = await sb.from('habits').insert({ user_id: me.id, name: title });
  if (error) { toast('হয়নি'); return; }
  closeSheet(); renderHabits();
}
async function logHabit(habitId){
  const { error } = await sb.from('habit_logs').insert({ habit_id: habitId, user_id: me.id, day: new Date().toISOString().slice(0, 10) });
  if (error) { toast('আজকেরটা আগেই নেওয়া হয়েছে'); return; }
  toast('দারুণ! আজকের অভ্যাস সম্পন্ন 🌱'); renderHabits();
}
async function renderPets(){
  toast('এই অংশটা আপাতত বন্ধ আছে'); go('feed'); return;
  curView = 'pets'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('paw', 19)} পোষা প্রাণীর প্রোফাইল</div>
    <div style="padding:12px 12px 0"><button class="btn block" onclick="petSheet()">+ আমার পোষা প্রাণী যোগ করো</button></div>
    <div id="petList" style="padding:12px"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data } = await sb.from('pets').select('*').order('created_at', { ascending: false }).limit(40);
  await cacheProfiles((data || []).map(p => p.user_id));
  const el = document.getElementById('petList');
  if (el) el.innerHTML = (data || []).length ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${data.map(p => `<div class="card" style="margin:0;text-align:center">${p.photo_url ? `<img src="${esc(p.photo_url)}" style="width:100%;border-radius:12px;aspect-ratio:1;object-fit:cover">` : '<div style="color:var(--acc)">' + ic('paw', 44) + '</div>'}<b>${esc(p.name)}</b><br><small style="color:var(--mut)">${esc(p.kind || '')}</small><br><small style="color:var(--faint)">মালিক: ${esc(prof(p.user_id).name)}</small>${p.user_id === me.id ? `<br><button class="btn ghost sm" style="margin-top:6px" onclick="deletePet('${p.id}')">মুছো</button>` : ''}</div>`).join('')}</div>` : '<div class="card empty">এখনো কোনো পোষা প্রাণী যোগ হয়নি</div>';
}
function petSheet(){
  sheet(`<h3>${ic('paw', 18)} পোষা প্রাণী</h3><input class="field" id="ptName" placeholder="নাম (যেমন: মিনি)"><input class="field" id="ptKind" placeholder="কী প্রাণী? (বিড়াল/কুকুর/পাখি...)"><label style="font-size:13.5px;color:var(--mut)">ছবি <input type="file" id="ptImg" accept="image/*" style="font-size:12px"></label><button class="btn block" style="margin-top:10px" onclick="addPet()">যোগ করো</button>`);
}
async function addPet(){
  const name = document.getElementById('ptName').value.trim(); if (!name) { toast('নাম দাও'); return; }
  const f = document.getElementById('ptImg').files[0];
  const photo_url = f ? await uploadImage(f) : '';
  const { error } = await sb.from('pets').insert({ user_id: me.id, name, kind: document.getElementById('ptKind').value.trim(), photo_url });
  if (error) { toast('হয়নি'); return; }
  closeSheet(); toast('যোগ হয়েছে 🐾'); renderPets();
}
async function deletePet(id){
  await sb.from('pets').delete().eq('id', id); renderPets();
}
function askAnon(uid){
  sheet(`<h3>${ic('eyeOff', 18)} বেনামে প্রশ্ন করো</h3><p style="font-size:13px;color:var(--mut);margin-bottom:10px">তোমার নাম ওর কাছে যাবে না। ভদ্রভাবে প্রশ্ন করো।</p><textarea class="field" id="anonQ" placeholder="তোমার প্রশ্ন..."></textarea><button class="btn block" onclick="sendAnon('${uid}')">পাঠাও</button>`);
}
async function sendAnon(uid){
  const body = document.getElementById('anonQ').value.trim(); if (!body) return;
  const { error } = await sb.from('anon_questions').insert({ target: uid, body });
  if (error) { toast('যায়নি'); return; }
  await sb.from('notifications').insert({ user_id: uid, actor_id: null, type: 'anon' });
  closeSheet(); toast('বেনামে প্রশ্ন পাঠানো হয়েছে 🙈');
}
async function renderAnon(){
  curView = 'anon'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('eyeOff', 19)} বেনামি প্রশ্নের ইনবক্স</div>
    <p style="padding:6px 16px 0;font-size:13px;color:var(--mut)">বন্ধুরা তোমার প্রোফাইল থেকে বেনামে প্রশ্ন করতে পারে। উত্তর দিলে সেটা তোমার উত্তরের জায়গায় দেখা যাবে।</p>
    <div id="anonList" style="padding:12px"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data } = await sb.from('anon_questions').select('*').eq('target', me.id).order('created_at', { ascending: false }).limit(40);
  const el = document.getElementById('anonList');
  if (el) el.innerHTML = (data || []).length ? data.map(q => `<div class="card"><p style="font-size:14.5px">❓ ${esc(q.body)}</p><small style="color:var(--faint)">${timeAgo(q.created_at)}</small>${q.answer ? `<p style="margin-top:8px;background:var(--bg2,#F5F3FF);padding:9px 11px;border-radius:10px;font-size:14px">💬 তোমার উত্তর: ${esc(q.answer)}</p>` : `<div style="display:flex;gap:8px;margin-top:9px"><input class="field" style="margin:0;flex:1" id="ans-${q.id}" placeholder="উত্তর লেখো..."><button class="btn sm" onclick="answerAnon('${q.id}')">উত্তর দাও</button></div>`}</div>`).join('') : '<div class="card empty">এখনো কোনো বেনামি প্রশ্ন আসেনি</div>';
}
async function answerAnon(qid){
  const v = document.getElementById('ans-' + qid).value.trim(); if (!v) return;
  await sb.from('anon_questions').update({ answer: v }).eq('id', qid);
  toast('উত্তর দেওয়া হয়েছে'); renderAnon();
}
async function renderCloseFriends(){
  curView = 'closefriends'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('heart', 19)} কাছের বন্ধুরা</div>
    <p style="padding:6px 16px 0;font-size:13px;color:var(--mut)">পোস্ট করার সময় "কাছের বন্ধুরা" বেছে নিলে শুধু এরাই দেখবে।</p>
    <div class="card" id="cfList" style="padding:6px 15px"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  await loadMyRelations();
  await cacheProfiles([...friendIds]);
  const el = document.getElementById('cfList');
  if (el) el.innerHTML = friendIds.size ? [...friendIds].map(id => { const p = prof(id); const has = myCloseIds.has(id); return userRow(p, `<button class="btn ${has ? 'ghost' : ''} sm" onclick="toggleCloseFriend('${id}',${has})">${has ? 'কাছের ✓ সরাও' : 'কাছের করো'}</button>`); }).join('') : '<div class="empty">আগে কিছু বন্ধু বানাও</div>';
}
async function toggleCloseFriend(uid, has){
  if (has) await sb.from('close_friends').delete().eq('owner', me.id).eq('friend', uid);
  else await sb.from('close_friends').insert({ owner: me.id, friend: uid });
  renderCloseFriends();
}

/* ---------- V2: PROFILE THEMES ---------- */
const PROFILE_THEMES = [
  ['sunset', 'সূর্যাস্ত', 'linear-gradient(120deg,#F59E0B,#EF4444,#EC4899)'],
  ['ocean', 'সাগর', 'linear-gradient(120deg,#0EA5E9,#2563EB,#7C3AED)'],
  ['forest', 'বন', 'linear-gradient(120deg,#059669,#65A30D,#F59E0B)'],
  ['royal', 'রাজকীয়', 'linear-gradient(120deg,#7C3AED,#DB2777,#F59E0B)'],
  ['night', 'রাতের আকাশ', 'linear-gradient(120deg,#111827,#374151,#6D28D9)']
];
async function renderThemes(){
  curView = 'themes'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('palette', 19)} প্রোফাইল থিম</div>
    <p style="padding:6px 16px 0;font-size:13px;color:var(--mut)">১০০ টোকেনে প্রিমিয়াম থিম কিনলে তোমার প্রোফাইলের কভার জায়গায় সেই রঙ ঝলমল করবে। ব্যালেন্স: <b>${bn(me.tokens)}</b></p>
    <div style="padding:12px">${PROFILE_THEMES.map(([id, name, grad]) => `<div class="card" style="overflow:hidden"><div style="height:64px;border-radius:12px;background:${grad}"></div><div style="display:flex;align-items:center;margin-top:10px"><b style="flex:1">${name}</b>${me.theme === id ? '<span class="pill">চালু আছে ✓</span>' : `<button class="btn sm" onclick="buyTheme('${id}')">১০০ টোকেনে নাও</button>`}</div></div>`).join('')}
    ${me.theme ? `<button class="btn ghost block" onclick="buyTheme('')">থিম সরিয়ে দাও</button>` : ''}</div></div>`;
}
async function buyTheme(themeId){
  if (!themeId) { await sb.from('profiles').update({ theme: '' }).eq('id', me.id); me.theme = ''; toast('থিম সরানো হয়েছে'); renderThemes(); return; }
  const { error } = await sb.rpc('rpc_spend', { p_item: 'theme', p_target: null });
  if (error) { toast('টোকেন যথেষ্ট নেই (লাগবে ১০০)'); return; }
  me.tokens -= 100;
  await sb.from('profiles').update({ theme: themeId }).eq('id', me.id);
  me.theme = themeId; profilesCache[me.id] = me;
  toast('থিম চালু হয়েছে 🎨'); renderThemes();
}

/* ---------- BOOT ---------- */
async function loadMyRelations(){
  const [fr, fo, bl, cfIn, cfOut] = await Promise.all([
    sb.from('friendships').select('*').or(`requester.eq.${me.id},addressee.eq.${me.id}`),
    sb.from('follows').select('following').eq('follower', me.id),
    sb.from('blocks').select('blocked').eq('blocker', me.id),
    sb.from('close_friends').select('owner').eq('friend', me.id),
    sb.from('close_friends').select('friend').eq('owner', me.id)
  ]);
  friendIds = new Set(); (fr.data || []).forEach(r => { if (r.status === 'accepted') friendIds.add(r.requester === me.id ? r.addressee : r.requester); });
  followIds = new Set((fo.data || []).map(r => r.following));
  blockedIds = new Set((bl.data || []).map(r => r.blocked));
  closeOfIds = new Set((cfIn.data || []).map(r => r.owner));
  myCloseIds = new Set((cfOut.data || []).map(r => r.friend));
  window._friendRows = fr.data || [];
}
async function refreshNotifBadge(){
  const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', me.id).eq('is_read', false);
  unreadNotifs = count || 0; renderShell();
}
function subscribeNotifs(){
  if (notifChannel) sb.removeChannel(notifChannel);
  notifChannel = sb.channel('notifs-' + me.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: 'user_id=eq.' + me.id }, () => { unreadNotifs++; renderShell(); })
    .subscribe();
}
/* Online presence: one shared channel; the chat list reads onlineIds for its green dots. */
function subscribePresence(){
  if (presenceChannel) sb.removeChannel(presenceChannel);
  presenceChannel = sb.channel('adda-online', { config: { presence: { key: me.id } } });
  presenceChannel.on('presence', { event: 'sync' }, () => {
    const next = new Set(Object.keys(presenceChannel.presenceState()));
    const changed = next.size !== onlineIds.size || [...next].some(id => !onlineIds.has(id));
    onlineIds = next;
    if (changed && curView === 'chat' && !activeChat) renderChatList(chatListMode);
    if (activeChat) {
      let typer = null;
      const st = presenceChannel.presenceState();
      for (const k of Object.keys(st)) { if (k === me.id) continue; for (const e of st[k]) { if (e && e.typing === activeChat) { typer = e; break; } } if (typer) break; }
      if (typer) showTyping(typer.name || 'বন্ধু');
    }
  }).subscribe(async status => {
    if (status === 'SUBSCRIBED') { try { await presenceChannel.track({ user_id: me.id }); } catch (e) {} }
  });
}
async function boot(){
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { renderAuth(); return; }
  let { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
  if (!profile) {
    const name = session.user.user_metadata?.name || (session.user.email || 'ব্যবহারকারী').split('@')[0];
    const ins = await sb.from('profiles').insert({ id: session.user.id, name, tokens: 100 }).select().single();
    profile = ins.data;
  }
  me = profile; profilesCache[me.id] = me;
  if (localStorage.getItem('adda-theme') === 'dark') document.documentElement.classList.add('dark');
  if (localStorage.getItem('adda-big') === '1') document.documentElement.classList.add('big');
  await loadMyRelations();
  // login streak: last_login_date still holds YESTERDAY-or-older here (rpc_award updates it)
  const todayStr = new Date().toISOString().slice(0, 10);
  const yestStr = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  let newStreak = me.login_streak || 0;
  if (me.last_login_date !== todayStr) newStreak = (me.last_login_date === yestStr) ? newStreak + 1 : 1;
  sb.rpc('rpc_award', { p_reason: 'login' }).then(async ({ data }) => {
    if (typeof data === 'number') { me.tokens = data; profilesCache[me.id] = me; }
    if (me.last_login_date !== todayStr) {
      me.login_streak = newStreak; me.last_login_date = todayStr;
      await sb.from('profiles').update({ login_streak: newStreak }).eq('id', me.id);
    }
  });
  await refreshNotifBadge();
  subscribeNotifs();
  subscribePresence();
  startBreakReminder();
  const qu = new URLSearchParams(location.search).get('u');
  if (qu) {
    const { data: target } = await sb.from('profiles').select('id').eq('username', qu).maybeSingle();
    if (target) { goProfile(target.id); return; }
  }
  go('feed');
}
window.addEventListener('popstate', () => { history.pushState(null, '', location.href); closeSheet(); });
document.addEventListener('DOMContentLoaded', () => { history.pushState(null, '', location.href); boot(); });

/* ---------- UPLOAD ---------- */
async function uploadImage(file){
  if (!file) return '';
  const path = me.id + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
  const { error } = await sb.storage.from('media').upload(path, file, { contentType: file.type || 'image/jpeg' });
  if (error) { toast('ছবি আপলোড হয়নি'); return ''; }
  return sb.storage.from('media').getPublicUrl(path).data.publicUrl;
}

/* ---------- POSTS ---------- */
async function fetchPosts(opts = {}){
  let q = sb.from('posts').select('*').order('created_at', { ascending: false }).limit(120);
  if (opts.groupId) q = q.eq('group_id', opts.groupId);
  else if (!opts.authorId && !opts.tag && !opts.savedOnly) q = q.is('group_id', null);
  if (opts.authorId) q = q.eq('user_id', opts.authorId);
  const { data: posts } = await q;
  let list = posts || [];
  if (opts.tag) list = list.filter(p => (p.body || '').includes('#' + opts.tag));
  if (opts.savedOnly) {
    const { data: sv } = await sb.from('saves').select('post_id').eq('user_id', me.id);
    const ids = new Set((sv || []).map(r => r.post_id));
    list = list.filter(p => ids.has(p.id));
  }
  list = list.filter(p => !blockedIds.has(p.user_id));
  if (opts.archivedOnly) list = list.filter(p => p.archived);
  else list = list.filter(p => !p.archived);
  const nowMs = Date.now();
  list = list.filter(p => {
    if (p.scheduled_at && new Date(p.scheduled_at).getTime() > nowMs && p.user_id !== me.id) return false;
    if (p.user_id === me.id) return true;
    const aud = p.audience || 'public';
    if (aud === 'public') return true;
    if (aud === 'friends') return friendIds.has(p.user_id);
    if (aud === 'close') return closeOfIds.has(p.user_id);
    if (aud === 'supporters') return followIds.has(p.user_id);
    return true;
  });
  if (!list.length) return [];
  const ids = list.map(p => p.id);
  await cacheProfiles(list.map(p => p.user_id));
  await cachePages(list.map(p => p.page_id));
  const [likes, comments, myLikes, mySaves, pollVotes] = await Promise.all([
    sb.from('likes').select('post_id').in('post_id', ids),
    sb.from('comments').select('post_id').in('post_id', ids),
    sb.from('likes').select('post_id').eq('user_id', me.id).in('post_id', ids),
    sb.from('saves').select('post_id').eq('user_id', me.id).in('post_id', ids),
    sb.from('poll_votes').select('*').in('post_id', ids)
  ]);
  const lc = {}, cc = {}, pv = {};
  (likes.data || []).forEach(r => lc[r.post_id] = (lc[r.post_id] || 0) + 1);
  (comments.data || []).forEach(r => cc[r.post_id] = (cc[r.post_id] || 0) + 1);
  (pollVotes.data || []).forEach(r => { (pv[r.post_id] = pv[r.post_id] || []).push(r); });
  const myL = new Set((myLikes.data || []).map(r => r.post_id));
  const myS = new Set((mySaves.data || []).map(r => r.post_id));
  list.forEach(p => {
    p._likes = lc[p.id] || 0; p._comments = cc[p.id] || 0;
    p._liked = myL.has(p.id); p._saved = myS.has(p.id);
    p._votes = pv[p.id] || []; p._myVote = (pv[p.id] || []).find(v => v.user_id === me.id);
  });
  return list;
}
function feedScore(p){
  let s = p._likes * 3 + p._comments * 5;
  if (p.boost_until && new Date(p.boost_until) > new Date()) s += 500;
  if (friendIds.has(p.user_id) || followIds.has(p.user_id)) s += 40;
  if (p.user_id === me.id) s += 10;
  s -= (Date.now() - new Date(p.created_at).getTime()) / 3600000 * 0.7;
  return s;
}
function pollHtml(p){
  if (!p.poll || !Array.isArray(p.poll.options)) return '';
  const total = p._votes.length;
  return `<div class="poll">${p.poll.options.map((opt, i) => {
    const cnt = p._votes.filter(v => v.option_idx === i).length;
    const pct = total ? Math.round(cnt / total * 100) : 0;
    return `<button onclick="votePoll('${p.id}',${i})">${p._myVote ? `<span class="fill" style="width:${pct}%"></span>` : ''}<span>${esc(opt)}${p._myVote && p._myVote.option_idx === i ? ' ✓' : ''}</span>${p._myVote ? `<span class="pct">${bn(pct)}%</span>` : ''}</button>`;
  }).join('')}<small style="color:var(--faint);font-size:11.5px">${bn(total)}টি ভোট</small></div>`;
}
function postCard(p){
  const pg = p.page_id ? pagesCache[p.page_id] : null;
  const a = pg || prof(p.user_id);
  const openFn = pg ? `renderPageDetail('${pg.id}')` : `goProfile('${a.id}')`;
  const boosted = p.boost_until && new Date(p.boost_until) > new Date();
  return `<div class="card" id="post-${p.id}">
    <div class="chead">
      <a href="#" onclick="${openFn};return false">${avatar(a, 42, 16)}</a>
      <div style="flex:1;min-width:0"><b><a href="#" style="color:var(--ink)" onclick="${openFn};return false">${esc(a.name)}</a>${pg ? '<span class="pill">পেজ</span>' : badges(a)}${p.pinned ? ' ' + ic('pin', 13) : ''}${boosted ? '<span class="boosted">বুস্ট করা</span>' : ''}</b>
      <small>${timeAgo(p.created_at)}${p.location ? ' · 📍 ' + esc(p.location) : ''}${p.feeling ? ' · অনুভূতি: ' + esc(p.feeling) : ''}</small></div>
      <button class="icb" style="width:32px;height:32px" onclick="postMenu('${p.id}')">${I.dots}</button>
    </div>
    ${p.body ? `<div class="ptext">${linkTags(p.body)}</div>` : ''}
    ${p.image_url ? (localStorage.getItem('adda-saver') === '1' ? `<button class="btn ghost sm" data-photosrc="${esc(p.image_url)}" onclick="showPhoto(this)">${ic('img', 14)} ছবি দেখো (ডেটা সেভার)</button>` : `<img class="pimg" src="${esc(p.image_url)}" loading="lazy" alt="">`) : ''}
    ${p.video_url ? `<video class="pimg" src="${esc(p.video_url)}" controls preload="metadata" playsinline></video>` : ''}
    ${pollHtml(p)}
    <div class="counts"><span>${bn(p._likes)} লাইক</span><span>${bn(p._comments)} মন্তব্য</span></div>
    <div class="acts">
      <button class="${p._liked ? 'liked' : ''}" onclick="toggleLike('${p.id}',this)">${I.heart}লাইক</button>
      <button onclick="openComments('${p.id}')">${I.comment}মন্তব্য</button>
      <button class="${p._saved ? 'saved' : ''}" onclick="toggleSave('${p.id}',this)">${I.bookmark}সেভ</button>
    </div></div>`;
}
async function toggleLike(postId, btn){
  const { data: post } = await sb.from('posts').select('user_id').eq('id', postId).single();
  const { data: existing } = await sb.from('likes').select('post_id').eq('post_id', postId).eq('user_id', me.id).maybeSingle();
  if (existing) { await sb.from('likes').delete().eq('post_id', postId).eq('user_id', me.id); }
  else { await sb.from('likes').insert({ post_id: postId, user_id: me.id }); if (post) notify(post.user_id, 'like', postId); }
  refreshPost(postId);
}
async function toggleSave(postId, btn){
  const { data: existing } = await sb.from('saves').select('post_id').eq('post_id', postId).eq('user_id', me.id).maybeSingle();
  if (existing) { const { error } = await sb.from('saves').delete().eq('post_id', postId).eq('user_id', me.id); if (error) { toast('সেভ সরানো যায়নি'); return; } toast('সেভ সরানো হয়েছে'); }
  else { const { error } = await sb.from('saves').insert({ post_id: postId, user_id: me.id }); if (error) { toast('পোস্ট সেভ হয়নি'); return; } toast('পোস্ট সেভ হয়েছে'); }
  refreshPost(postId);
}
async function refreshPost(postId){
  const el = document.getElementById('post-' + postId); if (!el) return;
  const { data: p } = await sb.from('posts').select('*').eq('id', postId).single(); if (!p) { el.remove(); return; }
  const [one] = await fetchPostsByIds([p]); el.outerHTML = postCard(one);
}
async function cachePages(ids){
  const missing = [...new Set(ids)].filter(id => id && !pagesCache[id]);
  if (!missing.length) return;
  const { data } = await sb.from('pages').select('*').in('id', missing);
  (data || []).forEach(pg => pagesCache[pg.id] = pg);
}
async function fetchPostsByIds(posts){
  const ids = posts.map(p => p.id);
  await cacheProfiles(posts.map(p => p.user_id));
  await cachePages(posts.map(p => p.page_id));
  const [likes, comments, myLikes, mySaves, pollVotes] = await Promise.all([
    sb.from('likes').select('post_id').in('post_id', ids),
    sb.from('comments').select('post_id').in('post_id', ids),
    sb.from('likes').select('post_id').eq('user_id', me.id).in('post_id', ids),
    sb.from('saves').select('post_id').eq('user_id', me.id).in('post_id', ids),
    sb.from('poll_votes').select('*').in('post_id', ids)
  ]);
  const lc = {}, cc = {}, pv = {};
  (likes.data || []).forEach(r => lc[r.post_id] = (lc[r.post_id] || 0) + 1);
  (comments.data || []).forEach(r => cc[r.post_id] = (cc[r.post_id] || 0) + 1);
  (pollVotes.data || []).forEach(r => { (pv[r.post_id] = pv[r.post_id] || []).push(r); });
  const myL = new Set((myLikes.data || []).map(r => r.post_id));
  const myS = new Set((mySaves.data || []).map(r => r.post_id));
  posts.forEach(p => { p._likes = lc[p.id] || 0; p._comments = cc[p.id] || 0; p._liked = myL.has(p.id); p._saved = myS.has(p.id); p._votes = pv[p.id] || []; p._myVote = (pv[p.id] || []).find(v => v.user_id === me.id); });
  return posts;
}
async function votePoll(postId, idx){
  const { data: mine } = await sb.from('poll_votes').select('*').eq('post_id', postId).eq('user_id', me.id).maybeSingle();
  if (mine) { toast('তুমি ইতিমধ্যে ভোট দিয়েছ'); return; }
  await sb.from('poll_votes').insert({ post_id: postId, user_id: me.id, option_idx: idx });
  refreshPost(postId);
}
async function openComments(postId){
  const { data: post } = await sb.from('posts').select('user_id').eq('id', postId).single();
  const { data: comments } = await sb.from('comments').select('*').eq('post_id', postId).order('created_at');
  await cacheProfiles((comments || []).map(c => c.user_id));
  sheet(`<h3>মন্তব্য</h3>
    <div id="clist">${(comments || []).map(c => { const a = prof(c.user_id); return `<div class="row">${avatar(a, 34, 13)}<div style="flex:1"><b>${esc(a.name)}</b>${badges(a)}${c.audio_url ? `<audio controls src="${esc(c.audio_url)}" style="width:100%;height:34px;margin-top:4px"></audio>` : `<small style="display:block;color:var(--ink2);font-size:13.5px">${esc(c.body)}</small>`}<small>${timeAgo(c.created_at)}</small></div></div>`; }).join('') || '<div class="empty">এখনো কোনো মন্তব্য নেই — প্রথমটা তুমিই করো</div>'}</div>
    <div style="display:flex;gap:8px;margin-top:12px;align-items:center"><input class="field" style="margin:0;flex:1" id="cinput" placeholder="মন্তব্য লেখো..."><label class="icb" style="cursor:pointer">${I.mic}<input type="file" accept="audio/*" style="display:none" onchange="addVoiceComment('${postId}','${post ? post.user_id : ''}',this)"></label><button class="btn" onclick="addComment('${postId}','${post ? post.user_id : ''}')">পাঠাও</button></div>`);
  $('#cinput').focus();
}
async function addVoiceComment(postId, ownerId, input){
  const f = input.files[0]; if (!f) return;
  toast('ভয়েস আপলোড হচ্ছে...');
  const url = await uploadImage(f);
  if (!url) { toast('আপলোড হয়নি'); return; }
  const { error } = await sb.from('comments').insert({ post_id: postId, user_id: me.id, body: '🎤 ভয়েস মন্তব্য', audio_url: url });
  if (error) { toast('যায়নি'); return; }
  if (ownerId) notify(ownerId, 'comment', postId);
  openComments(postId); refreshPost(postId);
}
async function addComment(postId, ownerId){
  const body = $('#cinput').value.trim(); if (!body) return;
  const { error } = await sb.from('comments').insert({ post_id: postId, user_id: me.id, body });
  if (error) { toast('মন্তব্য যায়নি'); return; }
  if (ownerId) notify(ownerId, 'comment', postId);
  sb.rpc('rpc_award', { p_reason: 'comment' });
  openComments(postId); refreshPost(postId);
}
function postMenu(postId){
  sheet(`<h3>পোস্টের অপশন</h3><div id="pmenu">লোড হচ্ছে...</div>`);
  sb.from('posts').select('*').eq('id', postId).single().then(async ({ data: p }) => {
    if (!p) { closeSheet(); return; }
    const mine = p.user_id === me.id;
    const boosted = p.boost_until && new Date(p.boost_until) > new Date();
    $('#pmenu').innerHTML = `
      ${mine ? `<button class="menu-item" onclick="editPost('${p.id}')">${ic('edit')} পোস্ট এডিট করো</button>
      <button class="menu-item" onclick="togglePin('${p.id}',${p.pinned ? 'false' : 'true'})">${p.pinned ? ic('pin') + ' পিন সরাও' : ic('pin') + ' প্রোফাইলে পিন করো'}</button>
      <button class="menu-item" onclick="toggleArchive('${p.id}',${p.archived ? 'false' : 'true'})">${ic('archive')} ${p.archived ? 'আর্কাইভ থেকে ফেরাও' : 'আর্কাইভ করো'}</button>
      <button class="menu-item" onclick="speakPost('${p.id}')">${ic('volume')} পোস্ট পড়ে শোনাও</button>
      <button class="menu-item" onclick="translatePost('${p.id}')">${ic('globe')} ইংরেজিতে অনুবাদ</button>
      ${!boosted ? `<button class="menu-item" onclick="boostPost('${p.id}')">${ic('rocket')} বুস্ট করো (৫০ টোকেন, ২৪ ঘণ্টা)</button>` : '<div class="menu-item">' + ic('rocket') + ' এই পোস্ট বুস্ট অবস্থায় আছে</div>'}
      <button class="menu-item" style="color:var(--danger)" onclick="deletePost('${p.id}')">${ic('trash')} পোস্ট মুছে ফেলো</button>`
      : `<button class="menu-item" onclick="reportItem('post','${p.id}')">${ic('flag')} রিপোর্ট করো</button>
         <button class="menu-item" style="color:var(--danger)" onclick="blockUser('${p.user_id}')">${ic('ban')} এই ব্যবহারকারীকে ব্লক করো</button>`}
      <button class="menu-item" onclick="closeSheet()">বন্ধ করো</button>`;
  });
}
async function editPost(postId){
  const { data: p } = await sb.from('posts').select('*').eq('id', postId).single();
  sheet(`<h3>পোস্ট এডিট</h3><textarea class="field" id="editBody">${esc(p.body)}</textarea>
    <button class="btn block" onclick="saveEdit('${postId}')">সংরক্ষণ করো</button>`);
}
async function saveEdit(postId){
  await sb.from('posts').update({ body: $('#editBody').value }).eq('id', postId);
  closeSheet(); refreshPost(postId); toast('পোস্ট আপডেট হয়েছে');
}
async function deletePost(postId){
  await sb.from('posts').delete().eq('id', postId);
  closeSheet(); const el = document.getElementById('post-' + postId); if (el) el.remove(); toast('পোস্ট মুছে গেছে');
}
async function boostPost(postId){
  const { error } = await sb.rpc('rpc_spend', { p_item: 'boost', p_target: postId });
  if (error) { toast('টোকেন যথেষ্ট নেই'); return; }
  me.tokens -= 50; closeSheet(); refreshPost(postId); toast('পোস্ট ২৪ ঘণ্টার জন্য বুস্ট হয়েছে 🚀');
}
async function togglePin(postId, pin){
  await sb.from('posts').update({ pinned: pin }).eq('id', postId);
  closeSheet(); toast(pin ? 'পোস্ট পিন করা হয়েছে 📌' : 'পিন সরানো হয়েছে');
  if (curView === 'profile') renderProfile(me.id); else refreshPost(postId);
}
async function toggleArchive(postId, arch){
  await sb.from('posts').update({ archived: arch }).eq('id', postId);
  closeSheet(); toast(arch ? 'পোস্ট আর্কাইভ হয়েছে 🗄' : 'পোস্ট ফিরিয়ে আনা হয়েছে');
  const el = document.getElementById('post-' + postId); if (el) el.remove();
}
function speakPost(postId){
  closeSheet();
  sb.from('posts').select('body').eq('id', postId).single().then(({ data }) => {
    if (!data || !data.body) { toast('শোনানোর মতো লেখা নেই'); return; }
    const u = new SpeechSynthesisUtterance(data.body); u.lang = 'bn-BD';
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  });
}
async function translatePost(postId){
  closeSheet();
  const { data } = await sb.from('posts').select('body').eq('id', postId).single();
  if (!data || !data.body) { toast('অনুবাদের মতো লেখা নেই'); return; }
  toast('অনুবাদ হচ্ছে...');
  try {
    const r = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(data.body.slice(0, 450)) + '&langpair=bn|en');
    const j = await r.json();
    const t = j.responseData && j.responseData.translatedText;
    sheet(`<h3>${ic('globe', 17)} English translation</h3><p style="font-size:14.5px;line-height:1.7">${esc(t || 'পাওয়া যায়নি')}</p>`);
  } catch { toast('অনুবাদ হয়নি — নেট চেক করো'); }
}
async function reportItem(type, id){
  await sb.from('reports').insert({ reporter: me.id, target_type: type, target_id: id, reason: '' });
  closeSheet(); toast('রিপোর্ট পাঠানো হয়েছে — ধন্যবাদ');
}
async function blockUser(uid){
  await sb.from('blocks').insert({ blocker: me.id, blocked: uid });
  blockedIds.add(uid); closeSheet(); toast('ব্লক করা হয়েছে'); go(curView === 'feed' ? 'feed' : curView);
}

/* ---------- COMPOSER ---------- */
function openComposer(groupId = null, pageId = null){
  sheet(`<h3>${groupId ? 'গ্রুপে পোস্ট' : (pageId ? 'পেজে পোস্ট' : 'নতুন পোস্ট')}</h3>
    <textarea class="field" id="postBody" placeholder="মনে কী চলছে, ${esc(me.name.split(' ')[0])}?" oninput="document.getElementById('charCount').textContent = this.value.length + ' অক্ষর'"></textarea>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:-4px 0 8px"><small id="charCount" style="color:var(--faint)">0 অক্ষর</small><small style="color:var(--faint)">টিপস: #হ্যাশট্যাগ দিলে ট্রেন্ডিংয়ে উঠবে</small></div>
    <div style="display:flex;gap:8px"><input class="field" style="flex:1" id="postFeeling" placeholder="অনুভূতি (ঐচ্ছিক)"><input class="field" style="flex:1" id="postLoc" placeholder="জায়গা (ঐচ্ছিক)"></div>
    <div style="display:flex;gap:8px;align-items:center">
      <select class="field" id="postAudience" style="flex:1">
        <option value="public">সবাই দেখবে</option>
        <option value="friends">শুধু বন্ধুরা</option>
        <option value="close">কাছের বন্ধুরা</option>
        <option value="supporters">ফলোয়াররা</option>
      </select>
      <input class="field" type="datetime-local" id="postWhen" style="flex:1" title="পরে প্রকাশ করতে চাইলে সময় দাও">
    </div>
    <label style="display:flex;gap:8px;align-items:center;font-size:13.5px;color:var(--mut);margin:4px 0 6px">${ic('img', 16)} ছবি যোগ করো <input type="file" id="postImg" accept="image/*" style="font-size:12px"></label>
    <label style="display:flex;gap:8px;align-items:center;font-size:13.5px;color:var(--mut);margin:0 0 6px">${ic('video', 16)} ভিডিও যোগ করো <input type="file" id="postVid" accept="video/*" style="font-size:12px"></label>
    <label style="display:flex;gap:8px;align-items:center;font-size:13.5px;color:var(--mut);margin:0 0 10px">${ic('grid', 16)} কোলাজ বানাও (২-৪টি ছবি) <input type="file" id="postCollage" accept="image/*" multiple style="font-size:12px"></label>
    <div id="pollBox" style="display:none">
      <input class="field poll-opt" placeholder="অপশন ১"><input class="field poll-opt" placeholder="অপশন ২">
      <input class="field poll-opt" placeholder="অপশন ৩ (ঐচ্ছিক)"><input class="field poll-opt" placeholder="অপশন ৪ (ঐচ্ছিক)">
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn ghost" style="flex:1" onclick="document.getElementById('pollBox').style.display='block'">${ic('chart', 15)} পোল যোগ করো</button>
      <button class="btn" style="flex:2" onclick="submitPost(${groupId ? `'${groupId}'` : 'null'},${pageId ? `'${pageId}'` : 'null'})">পোস্ট করো</button>
    </div>`);
  $('#postBody').focus();
  const pa = document.getElementById('postAudience');
  if (pa) pa.value = localStorage.getItem('adda-def-aud') || 'public';
}
async function makeCollage(files){
  const imgs = await Promise.all([...files].slice(0, 4).map(f => new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = URL.createObjectURL(f); })));
  const S = 900, half = S / 2;
  const cv = document.createElement('canvas'); cv.width = S; cv.height = imgs.length <= 2 ? half : S;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  const cells = imgs.length === 1 ? [[0, 0, S, S]] : imgs.length === 2 ? [[0, 0, half, half], [half, 0, half, half]] : [[0, 0, half, half], [half, 0, half, half], [0, half, half, half], [half, half, half, half]];
  imgs.forEach((im, i) => { const [x, y, w, h] = cells[i]; const sc = Math.max(w / im.width, h / im.height); const dw = im.width * sc, dh = im.height * sc; ctx.drawImage(im, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); });
  return new Promise(res => cv.toBlob(b => res(new File([b], 'collage.jpg', { type: 'image/jpeg' })), 'image/jpeg', 0.88));
}
async function submitPost(groupId, pageId){
  const body = $('#postBody').value.trim();
  const opts = [...document.querySelectorAll('.poll-opt')].map(i => i.value.trim()).filter(Boolean);
  const file = $('#postImg').files[0];
  const vidFile = $('#postVid').files[0];
  const colFiles = $('#postCollage').files;
  if (!body && !file && !vidFile && !colFiles.length && opts.length < 2) { toast('কিছু লেখো, ছবি দাও বা পোল বানাও'); return; }
  // simple spam guard: too many links or repeated spam posts
  const linkCount = (body.match(/https?:\/\//g) || []).length;
  if (linkCount > 2) { toast('এক পোস্টে ২টার বেশি লিংক দেওয়া যাবে না'); return; }
  const lastPostAt = +localStorage.getItem('adda-last-post') || 0;
  if (Date.now() - lastPostAt < 8000) { toast('একটু ধীরে — ৮ সেকেন্ড পর আবার পোস্ট করো'); return; }
  let image_url = '';
  if (colFiles.length >= 2) image_url = await uploadImage(await makeCollage(colFiles));
  else if (file) image_url = await uploadImage(file);
  let video_url = '';
  if (vidFile) { toast('ভিডিও আপলোড হচ্ছে...'); video_url = await uploadImage(vidFile); }
  const poll = opts.length >= 2 ? { options: opts } : null;
  const whenVal = $('#postWhen').value;
  const scheduled_at = whenVal ? new Date(whenVal).toISOString() : null;
  if (scheduled_at && new Date(scheduled_at) <= new Date()) { toast('শিডিউলের সময় ভবিষ্যতে দাও'); return; }
  const { error } = await sb.from('posts').insert({ user_id: me.id, body, image_url, video_url, feeling: $('#postFeeling').value.trim(), location: $('#postLoc').value.trim(), poll, group_id: groupId, page_id: pageId, audience: $('#postAudience').value, scheduled_at });
  if (error) { toast('পোস্ট হয়নি, আবার চেষ্টা করো'); return; }
  localStorage.setItem('adda-last-post', Date.now());
  sb.rpc('rpc_award', { p_reason: 'post' }).then(({ data }) => { if (typeof data === 'number') { me.tokens = data; const b = document.getElementById('feedTokens'); if (b) b.textContent = '🪙 টোকেন: ' + bn(me.tokens); } });
  closeSheet(); toast(scheduled_at ? 'পোস্ট শিডিউল হয়েছে ⏰' : 'পোস্ট হয়েছে ✓ (+১৫ টোকেন)');
  if (groupId) renderGroupDetail(groupId); else if (pageId) renderPageDetail(pageId); else if (curView === 'feed') renderFeed(); else if (curView === 'profile') renderProfile(me.id);
}

/* ---------- FEED ---------- */
async function specialBanners(){
  const today = new Date(); const md = String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  const ids = [...friendIds];
  await cacheProfiles(ids);
  let out = '';
  ids.forEach(id => {
    const p = profilesCache[id];
    if (p && p.birthday && p.birthday.slice(5) === md)
      out += `<div class="card" style="background:linear-gradient(120deg,#fdf2f8,#ede9fe)"><b>🎂 আজ ${esc(p.name)}-এর জন্মদিন!</b><br><small style="color:var(--mut)">শুভেচ্ছা জানিয়ে একটা পোস্ট করো</small><br><button class="btn sm" style="margin-top:8px" onclick="birthdayWish('${p.id}')">শুভেচ্ছা পাঠাও</button></div>`;
  });
  (window._friendRows || []).forEach(r => {
    if (r.status !== 'accepted' || !r.updated_at) return;
    const d = new Date(r.updated_at);
    const yrs = today.getFullYear() - d.getFullYear();
    if (yrs >= 1 && String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') === md) {
      const fid = r.requester === me.id ? r.addressee : r.requester;
      out += `<div class="card" style="background:linear-gradient(120deg,#ecfdf5,#eff6ff)"><b>🎉 ${esc((profilesCache[fid] || {}).name || 'বন্ধু')}-এর সাথে ${bn(yrs)} বছর বন্ধুত্ব!</b></div>`;
    }
  });
  const mem = await sb.from('posts').select('id,created_at').eq('user_id', me.id).limit(80);
  const old = (mem.data || []).find(p => { const d = new Date(p.created_at); return d.getFullYear() < today.getFullYear() && String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') === md; });
  if (old) out += `<div class="card" style="background:linear-gradient(120deg,#fffbeb,#fef3c7)"><b>🕰 এই দিনে</b> — তোমার পুরনো একটা পোস্ট আজকের দিনে হয়েছিল<br><button class="btn ghost sm" style="margin-top:8px" onclick="openMemory('${old.id}')">পোস্টটা দেখো</button></div>`;
  return out;
}
function birthdayWish(uid){
  const p = profilesCache[uid];
  openComposer();
  setTimeout(() => { const t = document.getElementById('postBody'); if (t) t.value = `শুভ জন্মদিন ${p ? p.name : ''} 🎂🎉 অনেক অনেক শুভেচ্ছা!`; }, 60);
}
async function viewPost(postId){
  const { data } = await sb.from('posts').select('*').eq('id', postId).single();
  if (!data) return;
  sheet((await fetchPostsByIds([data])).map(postCard).join(''));
}
async function openMemory(postId){
  const { data } = await sb.from('posts').select('*').eq('id', postId).single();
  if (!data) return;
  sheet(`<h3>${ic('clock', 18)} এই দিনে</h3>` + (await fetchPostsByIds([data])).map(postCard).join(''));
}
let myStories = [];
async function renderStoriesRow(){
  const row = document.getElementById('storiesRow');
  if (!row) return;
  const since = new Date(Date.now() - 864e5).toISOString();
  const { data } = await sb.from('stories').select('*').gt('created_at', since).order('created_at', { ascending: false });
  const stories = (data || []).filter(s => !blockedIds.has(s.user_id));
  myStories = stories;
  await cacheProfiles(stories.map(s => s.user_id));
  const byUser = {};
  stories.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });
  const mine = byUser[me.id] || [];
  let html = `<button class="story" onclick="${mine.length ? `openStory('${me.id}')` : 'openStoryComposer()'}"><span class="ring"><i>${me.avatar_url ? `<img src="${esc(me.avatar_url)}">` : esc(me.name[0] || 'অ')}</i></span>তুমি ${mine.length ? '' : '＋'}</button>`;
  Object.keys(byUser).filter(uid => uid !== me.id).forEach(uid => {
    const p = prof(uid);
    html += `<button class="story" onclick="openStory('${uid}')"><span class="ring"><i>${p.avatar_url ? `<img src="${esc(p.avatar_url)}">` : esc(p.name[0] || '?')}</i></span>${esc(p.name.split(' ')[0])}</button>`;
  });
  row.innerHTML = html;
}
function openStoryComposer(){
  sheet(`<h3>${ic('camera', 18)} নতুন স্টোরি (২৪ ঘণ্টা থাকবে)</h3>
    <input class="field" id="storyText" placeholder="লেখা (ঐচ্ছিক)">
    <label style="display:flex;gap:8px;align-items:center;font-size:13.5px;color:var(--mut);margin:6px 0">${ic('img', 16)} ছবি <input type="file" id="storyImg" accept="image/*" style="font-size:12px"></label>
    <label style="display:flex;gap:8px;align-items:center;font-size:13.5px;color:var(--mut);margin:0 0 12px">${ic('mic', 16)} ভয়েস <input type="file" id="storyAud" accept="audio/*" style="font-size:12px"></label>
    <button class="btn" style="width:100%" onclick="submitStory()">স্টোরি দাও</button>`);
}
async function submitStory(){
  const img = document.getElementById('storyImg').files[0];
  const aud = document.getElementById('storyAud').files[0];
  const text = document.getElementById('storyText').value.trim();
  if (!img && !aud && !text) { toast('ছবি, ভয়েস বা লেখা দাও'); return; }
  const image_url = img ? await uploadImage(img) : '';
  const audio_url = aud ? await uploadImage(aud) : '';
  const { error } = await sb.from('stories').insert({ user_id: me.id, image_url, audio_url, body: text });
  if (error) { toast('স্টোরি হয়নি'); return; }
  closeSheet(); toast('স্টোরি দেওয়া হয়েছে ✓');
  renderStoriesRow();
}
function openStory(uid){
  const list = myStories.filter(s => s.user_id === uid);
  if (!list.length) return;
  const p = prof(uid);
  sheet(`<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">${avatar(p, 36, 12)}<b>${esc(p.name)}</b><small style="color:var(--faint)">${timeAgo(list[0].created_at)}</small></div>` +
    list.map(s => `<div style="margin-bottom:12px">
      ${s.image_url ? `<img src="${esc(s.image_url)}" style="width:100%;border-radius:14px">` : ''}
      ${s.audio_url ? `<audio controls src="${esc(s.audio_url)}" style="width:100%"></audio>` : ''}
      ${s.body ? `<p style="font-size:15px;margin:6px 0">${esc(s.body)}</p>` : ''}
      ${uid === me.id ? `<button class="btn ghost sm" onclick="deleteStory('${s.id}')">${ic('trash', 14)} মুছো</button>` : `<button class="btn ghost sm" onclick="closeSheet();startChat('${uid}')">${ic('comment', 14)} রিপ্লাই দাও</button>`}
    </div>`).join(''));
}
async function deleteStory(id){
  await sb.from('stories').delete().eq('id', id);
  closeSheet(); toast('স্টোরি মোছা হয়েছে'); renderStoriesRow();
}
async function renderFeed(tagFilter = null){
  curView = 'feed'; renderShell();
  view().innerHTML = `<div class="view">
    <div class="stories" id="storiesRow"></div>
    <button class="composer" onclick="openComposer()">${avatar(me, 38, 15)}<span class="fake">মনে কী চলছে?</span><span style="color:var(--acc);display:flex">${ic('img', 20)}</span></button>
    <div style="display:flex;gap:8px;padding:12px 12px 0">
      <button class="btn ghost sm" style="flex:1" onclick="go('groups')">${ic('users', 15)} গ্রুপ</button>
      ${localStorage.getItem('adda-kid') === '1' ? '' : `<button class="btn ghost sm" style="flex:1" onclick="go('dating')">${ic('heart', 15)} মনের মানুষ</button>`}
    </div>
    <div style="display:flex;gap:8px;padding:8px 12px 0">
      <button class="btn ghost sm" style="flex:1" onclick="go('market')">${ic('bag', 15)} বাজার</button>
      <button class="btn ghost sm" style="flex:1" onclick="go('service')">${ic('hand', 15)} সেবা বোর্ড</button>
      <button class="btn ghost sm" style="flex:1" onclick="go('events')">${ic('calendar', 15)} ইভেন্ট</button>
      <button class="btn ghost sm" style="flex:1" onclick="go('pages')">${ic('file', 15)} পেজ</button>
    </div>
    ${tagFilter ? `<div style="padding:12px 16px 0;font-size:14px">ট্যাগ: <b>#${esc(tagFilter)}</b> <a href="#" onclick="renderFeed();return false">${ic('x', 13)} সব দেখো</a></div>` : ''}
    <div id="feedBanners" style="padding:12px 12px 0"></div>
    <div id="feedList"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  renderStoriesRow();
  specialBanners().then(b => { const el = document.getElementById('feedBanners'); if (el) el.innerHTML = b; });
  let posts = await fetchPosts(tagFilter ? { tag: tagFilter } : {});
  posts.sort((a, b) => feedScore(b) - feedScore(a));
  const fl = document.getElementById('feedList');
  if (fl) fl.innerHTML = posts.length ? posts.map(postCard).join('') : `<div class="card empty">এখনো কোনো পোস্ট নেই।<br>প্রথম পোস্টটা তুমিই করো — পাবে ১৫ টোকেন!</div>`;
}
function openTag(tag){ curView = 'feed'; renderFeed(tag); }

/* ---------- FRIENDS ---------- */
let friendsTab = 'suggest';
async function renderFriends(tab = 'suggest'){
  curView = 'friends'; friendsTab = tab; renderShell();
  view().innerHTML = `<div class="view">
    <div style="padding:14px 16px 0;font-size:18px;font-weight:800">বন্ধুরা</div>
    <div class="seg">
      <button class="${tab === 'suggest' ? 'on' : ''}" onclick="renderFriends('suggest')">পরামর্শ</button>
      <button class="${tab === 'requests' ? 'on' : ''}" onclick="renderFriends('requests')">অনুরোধ</button>
      <button class="${tab === 'mine' ? 'on' : ''}" onclick="renderFriends('mine')">আমার বন্ধু</button>
    </div>
    <div id="friendsBody"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const body = $('#friendsBody');
  if (tab === 'suggest') {
    const { data: all } = await sb.from('profiles').select('*').neq('id', me.id).limit(60);
    const { data: rels } = await sb.from('friendships').select('*').or(`requester.eq.${me.id},addressee.eq.${me.id}`);
    const related = new Set(); (rels || []).forEach(r => { related.add(r.requester); related.add(r.addressee); });
    const list = (all || []).filter(p => !related.has(p.id) && !blockedIds.has(p.id));
    body.innerHTML = `<div class="card" style="padding:6px 15px">${list.length ? list.map(p => userRow(p, `<button class="btn sm" onclick="sendFriendReq('${p.id}',this)">বন্ধু যোগ করো</button>`)).join('') : '<div class="empty">আপাতত নতুন কেউ নেই</div>'}</div>`;
  } else if (tab === 'requests') {
    const { data: reqs } = await sb.from('friendships').select('*').eq('addressee', me.id).eq('status', 'pending').order('created_at', { ascending: false });
    await cacheProfiles((reqs || []).map(r => r.requester));
    body.innerHTML = `<div class="card" style="padding:6px 15px">${(reqs || []).length ? reqs.map(r => { const p = prof(r.requester); return userRow(p, `<button class="btn sm" onclick="respondReq('${r.id}',true,this)">গ্রহণ</button> <button class="btn ghost sm" onclick="respondReq('${r.id}',false,this)">মুছো</button>`); }).join('') : '<div class="empty">কোনো অনুরোধ নেই</div>'}</div>`;
  } else {
    await cacheProfiles([...friendIds]);
    const list = [...friendIds].map(prof);
    body.innerHTML = `<div class="card" style="padding:6px 15px">${list.length ? list.map(p => userRow(p, `<button class="btn ghost sm" onclick="startChat('${p.id}')">মেসেজ</button>`)).join('') : '<div class="empty">এখনো কোনো বন্ধু নেই — পরামর্শ ট্যাব থেকে যোগ করো</div>'}</div>`;
  }
}
function userRow(p, actionHtml){
  return `<div class="row"><a href="#" onclick="goProfile('${p.id}');return false">${avatar(p, 46, 17)}</a>
    <div style="flex:1;min-width:0"><b><a href="#" style="color:var(--ink)" onclick="goProfile('${p.id}');return false">${esc(p.name)}</a>${badges(p)}</b>
    <small>${p.city ? '📍 ' + esc(p.city) + ' · ' : ''}${p.id === me.id ? 'তুমি' : (friendIds.has(p.id) ? 'বন্ধু' : 'নতুন মানুষ')}</small></div>
    <div style="display:flex;gap:6px">${actionHtml}</div></div>`;
}
async function sendFriendReq(uid, btn){
  const { error } = await sb.from('friendships').insert({ requester: me.id, addressee: uid });
  if (error) { toast('পাঠানো যায়নি'); return; }
  notify(uid, 'friend_request'); btn.textContent = 'পাঠানো হয়েছে ✓'; btn.disabled = true; btn.classList.add('ghost');
}
async function respondReq(id, accept, btn){
  if (accept) {
    const { data: r } = await sb.from('friendships').update({ status: 'accepted' }).eq('id', id).select().single();
    if (r) { friendIds.add(r.requester); notify(r.requester, 'friend_accept'); toast('নতুন বন্ধু যোগ হয়েছে 🎉'); }
  } else await sb.from('friendships').delete().eq('id', id);
  renderFriends('requests');
}
async function unfriend(uid){
  await sb.from('friendships').delete().or(`and(requester.eq.${me.id},addressee.eq.${uid}),and(requester.eq.${uid},addressee.eq.${me.id})`);
  friendIds.delete(uid); toast('বন্ধু তালিকা থেকে সরানো হয়েছে'); renderProfile(uid);
}
async function toggleFollow(uid, btn){
  if (followIds.has(uid)) { await sb.from('follows').delete().eq('follower', me.id).eq('following', uid); followIds.delete(uid); }
  else { await sb.from('follows').insert({ follower: me.id, following: uid }); followIds.add(uid); notify(uid, 'follow'); }
  renderProfile(uid);
}

/* ---------- TRENDING ---------- */
async function renderTrending(){
  curView = 'trending'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">ট্রেন্ডিং</div>
    <div class="card" id="trendTags" style="padding:6px 15px"><div class="empty">লোড হচ্ছে...</div></div>
    <div class="seclabel">জনপ্রিয় পোস্ট</div><div id="trendPosts"></div></div>`;
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const { data: posts } = await sb.from('posts').select('body').gte('created_at', since).limit(300);
  const counts = {};
  (posts || []).forEach(p => { const m = (p.body || '').match(/#([\p{L}\p{N}_]+)/gu) || []; m.forEach(t => counts[t] = (counts[t] || 0) + 1); });
  const tags = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  $('#trendTags').innerHTML = tags.length ? tags.map(([t, c], i) => `<button class="trend" onclick="openTag('${esc(t.slice(1))}')"><span class="rank ${i < 2 ? 'hot' : ''}">${bn(i + 1)}</span><span style="flex:1"><b>${esc(t)}</b><small>বাংলাদেশে ট্রেন্ডিং · ${bn(c)}টি পোস্ট</small></span><span style="color:var(--faint)">${I.fire.replace('currentColor','')}</span></button>`).join('') : '<div class="empty">এই সপ্তাহে এখনো কোনো হ্যাশট্যাগ ট্রেন্ড হয়নি — পোস্টে #ট্যাগ ব্যবহার করো!</div>';
  let pop = await fetchPosts({});
  pop.sort((a, b) => (b._likes * 3 + b._comments * 5) - (a._likes * 3 + a._comments * 5));
  $('#trendPosts').innerHTML = pop.slice(0, 10).map(postCard).join('') || '<div class="card empty">এখনো পোস্ট নেই</div>';
}

/* ---------- SEARCH ---------- */
function renderSearch(){
  curView = 'search'; renderShell();
  view().innerHTML = `<div class="view">
    <div class="searchbar">${ic('search', 17)}<input id="q" placeholder="মানুষ, পোস্ট বা গ্রুপ খোঁজো..." oninput="doSearch(this.value)"></div>
    <div id="searchRes"><div class="empty">নাম, জায়গা বা যেকোনো শব্দ লিখে খোঁজো</div></div></div>`;
  $('#q').focus();
}
let searchTimer = null;
function doSearch(q){
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    q = q.trim(); const box = $('#searchRes'); if (!box) return;
    if (q.length < 2) { box.innerHTML = '<div class="empty">কমপক্ষে ২ অক্ষর লেখো</div>'; return; }
    const [people, posts, groups] = await Promise.all([
      sb.from('profiles').select('*').or(`name.ilike.%${q}%,city.ilike.%${q}%`).limit(10),
      sb.from('posts').select('*').ilike('body', `%${q}%`).is('group_id', null).order('created_at', { ascending: false }).limit(10),
      sb.from('groups').select('*').ilike('name', `%${q}%`).limit(10)
    ]);
    await cacheProfiles((posts.data || []).map(p => p.user_id));
    const enriched = posts.data ? await fetchPostsByIds(posts.data) : [];
    box.innerHTML = `
      ${(people.data || []).length ? `<div class="seclabel">মানুষ</div><div class="card" style="padding:6px 15px">${people.data.map(p => userRow(p, p.id === me.id ? '' : `<button class="btn ghost sm" onclick="goProfile('${p.id}')">প্রোফাইল</button>`)).join('')}</div>` : ''}
      ${(groups.data || []).length ? `<div class="seclabel">গ্রুপ</div><div class="card" style="padding:6px 15px">${groups.data.map(g => groupRow(g)).join('')}</div>` : ''}
      ${enriched.length ? `<div class="seclabel">পোস্ট</div>${enriched.map(postCard).join('')}` : ''}
      ${!(people.data || []).length && !(groups.data || []).length && !enriched.length ? '<div class="empty">কিছু পাওয়া যায়নি</div>' : ''}`;
  }, 300);
}

/* ---------- NOTIFICATIONS ---------- */
const NOTIF_TEXT = { like: 'তোমার পোস্টে লাইক দিয়েছে', comment: 'তোমার পোস্টে মন্তব্য করেছে', friend_request: 'তোমাকে বন্ধুর অনুরোধ পাঠিয়েছে', friend_accept: 'তোমার বন্ধুর অনুরোধ গ্রহণ করেছে', follow: 'তোমাকে ফলো করেছে', gift: 'তোমাকে ১০০ টোকেন উপহার পাঠিয়েছে', match: 'তোমার সাথে ম্যাচ হয়েছে 💘', message: 'তোমাকে মেসেজ পাঠিয়েছে', anon: '🙈 তোমার কাছে একটা বেনামি প্রশ্ন এসেছে' };
async function renderNotifs(){
  curView = 'notifs'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px;font-size:18px;font-weight:800">নোটিফিকেশন</div><div id="notifList"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data } = await sb.from('notifications').select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(40);
  await cacheProfiles((data || []).map(n => n.actor_id));
  $('#notifList').innerHTML = (data || []).length ? data.map(n => { const a = prof(n.actor_id); return `<div class="notif ${n.is_read ? '' : 'is-unread'}">${avatar(a, 42, 16)}<div><p><b>${esc(a.name)}</b> ${NOTIF_TEXT[n.type] || 'নতুন আপডেট'}</p><small>${timeAgo(n.created_at)}</small></div></div>`; }).join('') : '<div class="empty">কোনো নোটিফিকেশন নেই</div>';
  await sb.from('notifications').update({ is_read: true }).eq('user_id', me.id).eq('is_read', false);
  unreadNotifs = 0; renderShell();
}

/* ---------- PROFILE ---------- */
async function goProfile(uid){ curView = 'profile'; renderProfile(uid); }
async function renderProfile(uid){
  curView = 'profile'; renderShell();
  const { data: p } = await sb.from('profiles').select('*').eq('id', uid).single();
  if (!p) { view().innerHTML = '<div class="empty">প্রোফাইল পাওয়া যায়নি</div>'; return; }
  profilesCache[uid] = p; const mine = uid === me.id;
  if (!mine) sb.from('profile_views').upsert({ viewer: me.id, profile: uid, created_at: new Date().toISOString() }, { onConflict: 'viewer,profile' }).then(() => {});
  const [friendsRes, postsRes, followersRes] = await Promise.all([
    sb.from('friendships').select('requester,addressee').eq('status', 'accepted').or(`requester.eq.${uid},addressee.eq.${uid}`),
    sb.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', uid),
    sb.from('follows').select('follower').eq('following', uid)
  ]);
  const friendCount = (friendsRes.data || []).length;
  const theirFriendIds = (friendsRes.data || []).map(r => r.requester === uid ? r.addressee : r.requester);
  view().innerHTML = `<div class="view">
    <div class="cover" ${safeUrl(p.cover_url) ? `style="background-image:url('${safeUrl(p.cover_url)}')"` : (p.theme ? `style="background:${(PROFILE_THEMES.find(t => t[0] === p.theme) || [])[2] || ''}"` : '')}></div>
    <div class="prof">
      <div class="big">${p.avatar_url ? `<img src="${esc(p.avatar_url)}">` : esc(p.name[0] || '?')}</div>
      <div style="font-size:20px;font-weight:800">${esc(p.name)}${badges(p)}</div>
      ${p.username ? `<p style="color:var(--acc);font-size:13px;margin-top:2px">@${esc(p.username)}</p>` : ''}
      ${p.nickname ? `<p style="color:var(--mut);font-size:13px;margin-top:1px">(${esc(p.nickname)})</p>` : ''}
      ${p.quote ? `<p style="font-size:13.5px;font-style:italic;color:var(--ink2);margin-top:5px">“${esc(p.quote)}”</p>` : ''}
      <p style="color:var(--mut);font-size:13px;margin-top:3px">${p.city ? '📍 ' + esc(p.city) + ' · ' : ''}${bn(friendCount)} জন বন্ধু${p.birthday ? ' · 🎂 ' + esc(p.birthday) : ''}</p>
      <div id="scamLabel"></div>
      <div style="margin-top:8px;display:flex;gap:8px;justify-content:center">
        <button class="btn ghost sm" onclick="copyProfileLink('${uid}')">${ic('link', 14)} লিংক কপি</button>
        <button class="btn ghost sm" onclick="showProfileQR('${uid}')">${ic('qr', 14)} QR কোড</button>
        ${mine ? `<button class="btn ghost sm" onclick="renderViewers()">${ic('eye', 14)} কে দেখল</button>` : ''}
      </div>
      ${p.bio ? `<p style="font-size:13.5px;color:var(--ink2);margin-top:7px;line-height:1.6">${esc(p.bio)}</p>` : ''}
      <div style="margin-top:12px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
      ${mine ? `<button class="btn" onclick="editProfile()">প্রোফাইল এডিট</button>
        <button class="btn ghost" onclick="go('settings')">${ic('gear', 14)} সেটিংস</button>`
      : `${friendIds.has(uid) ? `<button class="btn ghost" onclick="unfriend('${uid}')">বন্ধু ✓</button>` : `<button class="btn" onclick="sendFriendReq('${uid}',this)">বন্ধু যোগ করো</button>`}
        <button class="btn ${followIds.has(uid) ? 'ghost' : ''}" onclick="toggleFollow('${uid}',this)">${followIds.has(uid) ? 'ফলো করছ ✓' : 'ফলো করো'}</button>
        <button class="btn" onclick="startChat('${uid}')">মেসেজ</button>
        <button class="btn ghost" onclick="giftTokens('${uid}')">${ic('gift', 14)} উপহার (১০০)</button>
        <button class="btn ghost" onclick="askAnon('${uid}')">${ic('eyeOff', 14)} বেনামে প্রশ্ন</button>`}
      </div></div>
    <div class="stats"><div><b>${bn(postsRes.count || 0)}</b><small>পোস্ট</small></div><div><b>${bn(friendCount)}</b><small>বন্ধু</small></div><div><b>${bn((followersRes.data || []).length)}</b><small>ফলোয়ার</small></div></div>
    <div class="seclabel">পরিচিতি</div>
    <div class="card" style="padding:12px 15px">
      ${p.bio ? `<p style="font-size:14px;line-height:1.65;margin-bottom:8px">${esc(p.bio)}</p>` : ''}
      ${[['briefcase', '', p.work], ['grad', '', p.education], ['pinLoc', 'থাকেন', p.city], ['home', 'নিজ শহর', p.hometown], ['heart', '', p.relationship], ['calendar', 'জন্মদিন', p.birthday], ['user', '', p.gender], ['type', 'ভাষা', p.languages], ['palette', 'শখ', p.hobbies]].filter(r => r[2]).map(r => `<div style="font-size:13.5px;padding:3px 0;color:var(--ink2);display:flex;align-items:center;gap:7px"><span style="color:var(--acc);display:inline-flex">${ic(r[0], 15)}</span><span>${r[1] ? r[1] + ' ' : ''}${esc(r[2])}</span></div>`).join('')}
      ${p.website ? `<div style="font-size:13.5px;padding:3px 0;display:flex;align-items:center;gap:7px"><span style="color:var(--acc);display:inline-flex">${ic('globe', 15)}</span><a class="tag" target="_blank" rel="noopener" href="${esc(/^https?:\/\//i.test(p.website) ? p.website : 'https://' + p.website)}">${esc(p.website)}</a></div>` : ''}
      <div style="font-size:13.5px;padding:3px 0;color:var(--ink2)">📅 যোগ দিয়েছেন ${new Date(p.created_at).toLocaleDateString(LANG === 'en' ? 'en-US' : 'bn-BD', { month: 'long', year: 'numeric' })}</div>
      ${mine && !p.work && !p.education && !p.hometown ? `<button class="btn ghost sm" style="margin-top:8px" onclick="editProfile()">+ পরিচিতি যোগ করো</button>` : ''}
    </div>
    <div class="seclabel">ছবি</div><div id="profPhotos" style="padding:0 12px"><div class="empty">লোড হচ্ছে...</div></div>
    <div class="seclabel">বন্ধুরা · ${bn(friendCount)}</div><div id="profFriends" style="padding:0 12px"><div class="empty">লোড হচ্ছে...</div></div>
    <div class="seclabel">পোস্টসমূহ</div><div id="profPosts"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const posts = await fetchPosts({ authorId: uid });
  posts.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  const pp = document.getElementById('profPosts');
  if (pp) pp.innerHTML = posts.length ? posts.map(postCard).join('') : '<div class="card empty">এখনো কোনো পোস্ট নেই</div>';
  const photoPosts = posts.filter(x => x.image_url).slice(0, 9);
  const ph = document.getElementById('profPhotos');
  if (ph) ph.innerHTML = photoPosts.length ? `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">${photoPosts.map(x => `<img src="${esc(x.image_url)}" onclick="viewPost('${x.id}')" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:12px;cursor:pointer">`).join('')}</div>` : '<div class="card empty" style="margin:0">কোনো ছবির পোস্ট নেই</div>';
  await cacheProfiles(theirFriendIds.slice(0, 9));
  const pf = document.getElementById('profFriends');
  if (pf) pf.innerHTML = theirFriendIds.length ? `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${theirFriendIds.slice(0, 9).map(fid => { const fp = prof(fid); return `<button onclick="goProfile('${fid}')" style="background:var(--card);border:1px solid var(--line2);border-radius:14px;padding:10px 4px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:5px">${avatar(fp, 44, 16)}<small style="font-size:11.5px;font-weight:600;color:var(--ink)">${esc(fp.name.split(' ')[0])}</small></button>`; }).join('')}</div>` : '<div class="card empty" style="margin:0">এখনো কোনো বন্ধু নেই</div>';
  sb.rpc('report_count', { p_uid: uid }).then(({ data }) => {
    const el = document.getElementById('scamLabel');
    if (el && typeof data === 'number' && data >= 3) el.innerHTML = '<span style="display:inline-block;background:#FEF2F2;color:#B91C1C;border:1px solid #FECACA;border-radius:99px;padding:3px 10px;font-size:12px;font-weight:700;margin-top:6px">⚠️ সতর্কতা: এই অ্যাকাউন্টের বিরুদ্ধে একাধিক রিপোর্ট আছে — লেনদেনে সাবধান</span>';
  });
}
function profileLink(uid){
  const p = profilesCache[uid];
  return location.origin + location.pathname + (p && p.username ? '?u=' + encodeURIComponent(p.username) : '');
}
function copyProfileLink(uid){
  const link = profileLink(uid);
  if (!link.includes('?u=')) { toast('আগে প্রোফাইল এডিটে একটা ইউজারনেম সেট করো'); return; }
  navigator.clipboard.writeText(link).then(() => toast('প্রোফাইল লিংক কপি হয়েছে 🔗')).catch(() => toast(link));
}
function showProfileQR(uid){
  const link = profileLink(uid);
  sheet(`<h3>QR কোড</h3><div style="text-align:center"><img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(link)}" style="width:200px;height:200px;border-radius:12px" alt="QR"><p style="font-size:12.5px;color:var(--mut);margin-top:8px">${esc(link)}</p></div>`);
}
async function renderViewers(){
  curView = 'viewers'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('eye', 19)} প্রোফাইল দর্শক</div><div class="card" id="viewerList" style="padding:6px 15px"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data } = await sb.from('profile_views').select('*').eq('profile', me.id).order('created_at', { ascending: false }).limit(40);
  await cacheProfiles((data || []).map(v => v.viewer));
  const el = document.getElementById('viewerList');
  if (el) el.innerHTML = (data || []).length ? data.map(v => userRow(prof(v.viewer), `<small style="color:var(--faint)">${timeAgo(v.created_at)}</small>`)).join('') : '<div class="empty">এখনো কেউ তোমার প্রোফাইল দেখেনি</div>';
}
async function giftTokens(uid){
  const { error } = await sb.rpc('rpc_spend', { p_item: 'gift', p_target: uid });
  if (error) { toast('টোকেন যথেষ্ট নেই (লাগবে ১০০)'); return; }
  me.tokens -= 100; notify(uid, 'gift'); toast('১০০ টোকেন উপহার পাঠানো হয়েছে 🎁');
}
function toggleTheme(){
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('adda-theme', dark ? 'dark' : 'light');
}
function editProfile(){
  sheet(`<h3>প্রোফাইল এডিট</h3>
    <input class="field" id="epName" value="${esc(me.name)}" placeholder="নাম">
    <input class="field" id="epUsername" value="${esc(me.username || '')}" placeholder="ইউজারনেম (ইংরেজি ছোট হাতের, যেমন: limon.bd)">
    <input class="field" id="epCity" value="${esc(me.city || '')}" placeholder="শহর (যেমন: ঢাকা)">
    <label style="display:block;font-size:13px;color:var(--mut);margin:2px 0 4px">জন্মদিন <input class="field" type="date" id="epBirthday" value="${esc(me.birthday || '')}" style="margin:0"></label>
    <input class="field" id="epEmergency" value="${esc(me.emergency || '')}" placeholder="জরুরি যোগাযোগ (শুধু তুমিই দেখবে)">
    <input class="field" id="epWork" value="${esc(me.work || '')}" placeholder="কাজ / পেশা (যেমন: ছাত্র, শিক্ষক)">
    <input class="field" id="epEdu" value="${esc(me.education || '')}" placeholder="পড়াশোনা (যেমন: ঢাকা বিশ্ববিদ্যালয়)">
    <input class="field" id="epHome" value="${esc(me.hometown || '')}" placeholder="নিজ শহর (যেমন: রাজশাহী)">
    <select class="field" id="epRel"><option value="">সম্পর্কের অবস্থা (ঐচ্ছিক)</option>${['অবিবাহিত', 'সম্পর্কে আছি', 'বিবাহিত', 'জটিল'].map(r => `<option ${me.relationship === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
    <select class="field" id="epGender"><option value="">লিঙ্গ (ঐচ্ছিক)</option>${['পুরুষ', 'মহিলা', 'অন্যান্য'].map(g => `<option ${me.gender === g ? 'selected' : ''}>${g}</option>`).join('')}</select>
    <input class="field" id="epNick" value="${esc(me.nickname || '')}" placeholder="ডাকনাম (যেমন: লিমন)">
    <input class="field" id="epLang" value="${esc(me.languages || '')}" placeholder="ভাষা (যেমন: বাংলা, English)">
    <input class="field" id="epWeb" value="${esc(me.website || '')}" placeholder="ওয়েবসাইট (যেমন: example.com)">
    <input class="field" id="epHobby" value="${esc(me.hobbies || '')}" placeholder="শখ (যেমন: বই পড়া, ফুটবল, গান)">
    <input class="field" id="epQuote" value="${esc(me.quote || '')}" placeholder="পছন্দের উক্তি">
    <textarea class="field" id="epBio" placeholder="নিজের সম্পর্কে দু-এক লাইন">${esc(me.bio || '')}</textarea>
    <label style="display:block;font-size:13.5px;color:var(--mut);margin:2px 0 4px">প্রোফাইল ছবি <input type="file" id="epAvatar" accept="image/*" style="font-size:12px"></label>
    <label style="display:block;font-size:13.5px;color:var(--mut);margin:6px 0 12px">কভার ছবি <input type="file" id="epCover" accept="image/*" style="font-size:12px"></label>
    <button class="btn block" onclick="saveProfile()">সংরক্ষণ করো</button>`);
}
async function saveProfile(){
  const uname = $('#epUsername').value.trim().toLowerCase();
  if (uname && !/^[a-z0-9._]{3,30}$/.test(uname)) { toast('ইউজারনেমে শুধু ইংরেজি ছোট হাতের অক্ষর, সংখ্যা, . আর _ (৩-৩০)'); return; }
  const upd = { name: $('#epName').value.trim() || me.name, city: $('#epCity').value.trim(), bio: $('#epBio').value.trim(), username: uname || null, birthday: $('#epBirthday').value || null, emergency: $('#epEmergency').value.trim(), work: $('#epWork').value.trim(), education: $('#epEdu').value.trim(), hometown: $('#epHome').value.trim(), relationship: $('#epRel').value, gender: $('#epGender').value, nickname: $('#epNick').value.trim(), languages: $('#epLang').value.trim(), website: $('#epWeb').value.trim(), hobbies: $('#epHobby').value.trim(), quote: $('#epQuote').value.trim() };
  const af = $('#epAvatar').files[0]; if (af) upd.avatar_url = await uploadImage(af);
  const cf = $('#epCover').files[0]; if (cf) upd.cover_url = await uploadImage(cf);
  const { data, error } = await sb.from('profiles').update(upd).eq('id', me.id).select().single();
  if (error) { toast(error.message && error.message.includes('username') ? 'এই ইউজারনেম অন্য কেউ নিয়েছে' : 'সংরক্ষণ হয়নি'); return; }
  me = data; profilesCache[me.id] = me; closeSheet(); toast('প্রোফাইল আপডেট হয়েছে ✓'); renderProfile(me.id);
}
async function renderSaved(){
  curView = 'saved'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px;font-size:18px;font-weight:800">সেভ করা পোস্ট</div><div id="savedList"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const posts = await fetchPosts({ savedOnly: true });
  $('#savedList').innerHTML = posts.length ? posts.map(postCard).join('') : '<div class="card empty">কোনো সেভ করা পোস্ট নেই</div>';
}

/* ---------- GROUPS ---------- */
const GCATS = [['#4F46E5','grad'],['#059669','ball'],['#DB2777','music'],['#D97706','utensils'],['#0891B2','code'],['#7C3AED','book']];
async function renderGroups(){
  curView = 'groups'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">গ্রুপ</div>
    <div style="padding:12px 12px 0"><button class="btn block" onclick="createGroupSheet()">+ নতুন গ্রুপ বানাও</button></div>
    <div class="card" id="groupList" style="padding:6px 15px"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data: groups } = await sb.from('groups').select('*').order('created_at', { ascending: false }).limit(60);
  const { data: members } = await sb.from('group_members').select('group_id');
  const counts = {}; (members || []).forEach(m => counts[m.group_id] = (counts[m.group_id] || 0) + 1);
  const { data: mine } = await sb.from('group_members').select('group_id').eq('user_id', me.id);
  window._myGroups = new Set((mine || []).map(m => m.group_id));
  $('#groupList').innerHTML = (groups || []).length ? groups.map(g => groupRow(g, counts[g.id] || 0)).join('') : '<div class="empty">এখনো কোনো গ্রুপ নেই — প্রথমটা তুমিই বানাও!</div>';
}
function groupRow(g, memberCount){
  const [col, em] = GCATS[(g.name || '').length % GCATS.length];
  const joined = window._myGroups && window._myGroups.has(g.id);
  return `<div class="grp"><span class="gic" style="background:${col}">${ic(em, 20)}</span>
    <div style="flex:1;min-width:0"><b style="font-size:14.5px">${esc(g.name)}</b><small style="display:block;color:var(--faint);font-size:11.5px">${esc(g.category || 'সাধারণ')} · ${memberCount !== undefined ? bn(memberCount) + ' সদস্য' : ''}</small></div>
    <button class="btn ${joined ? 'ghost' : ''} sm" onclick="openGroup('${g.id}')">${joined ? 'খোলো' : 'যোগ দাও'}</button></div>`;
}
function createGroupSheet(){
  sheet(`<h3>নতুন গ্রুপ</h3>
    <input class="field" id="gName" placeholder="গ্রুপের নাম">
    <input class="field" id="gCat" placeholder="বিষয় (যেমন: পড়াশোনা, খেলা, গান)">
    <textarea class="field" id="gAbout" placeholder="গ্রুপ সম্পর্কে এক লাইন"></textarea>
    <button class="btn block" onclick="createGroup()">গ্রুপ বানাও</button>`);
}
async function createGroup(){
  const name = $('#gName').value.trim(); if (!name) { toast('গ্রুপের নাম দাও'); return; }
  const { data: g, error } = await sb.from('groups').insert({ name, category: $('#gCat').value.trim(), about: $('#gAbout').value.trim(), created_by: me.id }).select().single();
  if (error) { toast('গ্রুপ তৈরি হয়নি'); return; }
  await sb.from('group_members').insert({ group_id: g.id, user_id: me.id });
  closeSheet(); toast('গ্রুপ তৈরি হয়েছে 🎉'); openGroup(g.id);
}
async function openGroup(gid){
  const { data: isMember } = await sb.from('group_members').select('group_id').eq('group_id', gid).eq('user_id', me.id).maybeSingle();
  if (!isMember) {
    await sb.from('group_members').insert({ group_id: gid, user_id: me.id });
    toast('গ্রুপে যোগ দিয়েছ ✓');
  }
  renderGroupDetail(gid);
}
async function renderGroupDetail(gid){
  curView = 'groups'; renderShell();
  const { data: g } = await sb.from('groups').select('*').eq('id', gid).single();
  if (!g) { renderGroups(); return; }
  const { data: members } = await sb.from('group_members').select('user_id').eq('group_id', gid);
  view().innerHTML = `<div class="view">
    <div style="padding:14px 16px 0"><a href="#" onclick="renderGroups();return false" style="font-size:13.5px">← সব গ্রুপ</a>
    <div style="font-size:20px;font-weight:800;margin-top:6px">${esc(g.name)}</div>
    <p style="color:var(--mut);font-size:13px;margin-top:2px">${esc(g.category || '')} · ${bn((members || []).length)} সদস্য</p>
    ${g.about ? `<p style="font-size:13.5px;margin-top:6px;line-height:1.6">${esc(g.about)}</p>` : ''}
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn" style="flex:1" onclick="openComposer('${gid}')">গ্রুপে পোস্ট করো</button>
      <button class="btn ghost" style="flex:1" onclick="openGroupChat('${gid}')">গ্রুপ চ্যাট</button>
      <button class="btn ghost" onclick="leaveGroup('${gid}')">ছাড়ো</button>
    </div></div>
    <div class="card" style="margin:12px"><b>${ic('wallet', 16)} গ্রুপ তহবিল</b><div id="fundBox" style="margin-top:6px"><small style="color:var(--mut)">লোড হচ্ছে...</small></div>
      <div style="display:flex;gap:8px;margin-top:8px"><input class="field" type="number" id="fundAmt" placeholder="টোকেনের পরিমাণ" style="margin:0;flex:1" min="1" max="1000"><button class="btn sm" onclick="contributeFund('${gid}')">জমা দাও</button></div>
      <div id="fundTxns" style="margin-top:8px"></div></div>
    <div class="seclabel">গ্রুপের পোস্ট</div><div id="groupPosts"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const posts = await fetchPosts({ groupId: gid });
  $('#groupPosts').innerHTML = posts.length ? posts.map(postCard).join('') : '<div class="card empty">এই গ্রুপে এখনো পোস্ট নেই</div>';
  loadFund(gid);
}
async function loadFund(gid){
  const [{ data: fund }, { data: txns }] = await Promise.all([
    sb.from('group_funds').select('*').eq('group_id', gid).maybeSingle(),
    sb.from('group_fund_txns').select('*').eq('group_id', gid).order('created_at', { ascending: false }).limit(6)
  ]);
  await cacheProfiles((txns || []).map(t => t.user_id));
  const fb = document.getElementById('fundBox');
  if (fb) fb.innerHTML = `<span style="font-size:19px;font-weight:800;color:var(--acc)">${bn(fund ? fund.total : 0)} টোকেন</span> <small style="color:var(--mut)">জমা আছে — সবাই মিলে ভালো কাজে ব্যবহারের জন্য</small>`;
  const ft = document.getElementById('fundTxns');
  if (ft) ft.innerHTML = (txns || []).map(t => `<div style="font-size:12.5px;color:var(--mut)">${esc(prof(t.user_id).name)} · +${bn(t.amount)} · ${timeAgo(t.created_at)}</div>`).join('');
}
async function contributeFund(gid){
  const amt = parseInt(document.getElementById('fundAmt').value, 10);
  if (!amt || amt < 1) { toast('পরিমাণ দাও'); return; }
  const { error } = await sb.rpc('rpc_contribute', { p_group: gid, p_amount: amt });
  if (error) { toast('হয়নি — টোকেন কম বা তুমি সদস্য নও'); return; }
  me.tokens -= amt; toast('তহবিলে জমা হয়েছে 💰'); loadFund(gid);
}
async function leaveGroup(gid){
  await sb.from('group_members').delete().eq('group_id', gid).eq('user_id', me.id);
  toast('গ্রুপ ছেড়েছ'); renderGroups();
}

/* ---------- CHAT ---------- */
async function classifyRequests(reqRows, msgs){
  const out = new Map(); if (!reqRows.length) return out;
  const senderIds = [...new Set(reqRows.map(r => r.otherId).filter(Boolean))];
  const { data: myGm } = await sb.from('group_members').select('group_id').eq('user_id', me.id);
  const myGroups = new Set((myGm || []).map(g => g.group_id));
  const mutualCounts = {};
  await Promise.all(senderIds.map(async id => { const { data } = await sb.rpc('rpc_mutual_count', { a: me.id, b: id }); mutualCounts[id] = data || 0; }));
  const senderGroups = {};
  await Promise.all(senderIds.map(async id => { const { data } = await sb.from('group_members').select('group_id').eq('user_id', id); senderGroups[id] = new Set((data || []).map(g => g.group_id)); }));
  const reportCounts = {};
  await Promise.all(senderIds.map(async id => { const { data } = await sb.rpc('report_count', { p_uid: id }); reportCounts[id] = data || 0; }));
  reqRows.forEach(r => {
    const sid = r.otherId; if (!sid) { out.set(r.c.id, 'other'); return; }
    const mutual = mutualCounts[sid] || 0;
    const shared = [...(senderGroups[sid] || [])].some(g => myGroups.has(g));
    if (mutual > 0 || shared) { out.set(r.c.id, 'known'); return; }
    const p = prof(sid); let score = 0;
    const threadMsgs = (msgs || []).filter(m => m.conversation_id === r.c.id && m.sender_id === sid);
    const first = threadMsgs[threadMsgs.length - 1];
    if (first && /https?:\/\/|www\./i.test(first.body)) score += 2;
    if (p && p.created_at && (Date.now() - new Date(p.created_at).getTime()) < 7 * 864e5) score += 1;
    if (p && !p.avatar_url) score += 1;
    if ((reportCounts[sid] || 0) >= 3) score += 2;
    out.set(r.c.id, score >= 4 ? 'spam' : 'other');
  });
  return out;
}
async function renderChatList(mode = 'main'){
  curView = 'chat'; activeChat = null; renderShell();
  chatListMode = mode;
  if (typingChannel) { sb.removeChannel(typingChannel); typingChannel = null; }
  const head = mode === 'archived' ? 'আর্কাইভ করা চ্যাট' : mode === 'restricted' ? 'রেস্ট্রিক্ট করা চ্যাট' : mode === 'requests' ? 'মেসেজ রিকুয়েস্ট' : 'চ্যাট';
  view().innerHTML = `<div class="view"><div style="padding:14px 16px;font-size:18px;font-weight:800;display:flex;align-items:center;gap:9px">${mode !== 'main' ? `<button class="icb" style="width:34px;height:34px" onclick="renderChatList()">←</button>` : ''}${head}</div>${mode === 'main' ? '<div id="notesStrip"></div>' : ''}<div id="chatList"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  if (mode === 'main') renderNotesStrip();
  const { data: myConvs } = await sb.from('conversation_members').select('*').eq('user_id', me.id);
  const ids = (myConvs || []).map(r => r.conversation_id);
  if (!ids.length) { const cl = $('#chatList'); if (cl) cl.innerHTML = mode === 'main' ? '<div class="empty">এখনো কোনো চ্যাট নেই।<br>বন্ধুর প্রোফাইল থেকে "মেসেজ" চাপ দিলেই চ্যাট শুরু হবে।</div>' : '<div class="empty">এখানে কিছু নেই</div>'; return; }
  const myRowMap = {}; (myConvs || []).forEach(r => myRowMap[r.conversation_id] = r);
  const [{ data: convs }, { data: members }, { data: msgs }] = await Promise.all([
    sb.from('conversations').select('*').in('id', ids),
    sb.from('conversation_members').select('*').in('conversation_id', ids),
    sb.from('messages').select('*').in('conversation_id', ids).order('created_at', { ascending: false }).limit(600)
  ]);
  await cacheProfiles((members || []).map(m => m.user_id));
  const groupIds = (convs || []).map(c => c.group_id).filter(Boolean);
  const groupMap = {};
  if (groupIds.length) { const { data: gs } = await sb.from('groups').select('*').in('id', groupIds); (gs || []).forEach(g => groupMap[g.id] = g); }
  const lastMsg = {}; (msgs || []).forEach(m => { if (!lastMsg[m.conversation_id]) lastMsg[m.conversation_id] = m; });
  const rows = (convs || []).map(c => {
    const others = (members || []).filter(m => m.conversation_id === c.id && m.user_id !== me.id);
    const lm = lastMsg[c.id];
    const myRow = myRowMap[c.id] || {};
    let title, avHtml, otherId = null;
    if (c.is_group && c.group_id && groupMap[c.group_id]) { const g = groupMap[c.group_id]; title = g.name + ' (গ্রুপ)'; avHtml = `<span class="av" style="background:#4F46E5;width:47px;height:47px;font-size:17px">${ic('users', 20)}</span>`; }
    else if (others.length) { const p = prof(others[0].user_id); otherId = others[0].user_id; title = others[0].nickname || p.name; avHtml = avatar(p, 47, 17); }
    else { title = 'চ্যাট'; avHtml = avatar(null, 47, 17); }
    return { c, title, avHtml, lm, myRow, otherId, isReq: !!(myRow.requested && otherId && !friendIds.has(otherId)) };
  }).sort((a, b) => ((b.myRow.pinned ? 1 : 0) - (a.myRow.pinned ? 1 : 0)) || (new Date(b.lm?.created_at || b.c.created_at) - new Date(a.lm?.created_at || a.c.created_at)));
  const rowHtml = (r) => { const { c, title, avHtml, lm, myRow, otherId } = r; const masked = mode === 'requests' && lm && (lm.body.startsWith('📎FILE:') || lm.body.startsWith('🎧AUDIO:')); const pv = lm ? (masked ? tx('🔒 মিডিয়া পাঠিয়েছে','🔒 Sent media') : snippetOf(lm.body)) : null; return `<button class="chatrow" style="${r._cls === 'spam' ? 'opacity:.72' : ''}" onclick="openChat('${c.id}')"><span class="avw">${avHtml}${otherId && onlineIds.has(otherId) ? '<span class="ondot"></span>' : ''}</span><span style="flex:1;min-width:0"><b>${myRow.pinned ? ic('pin', 12) + ' ' : ''}${esc(title)}</b><small>${pv ? esc(pv) : 'চ্যাট শুরু করো'}</small></span>${myRow.muted ? `<span style="color:var(--faint);display:inline-flex">${ic('mute', 14)}</span>` : ''}<small style="color:var(--faint);font-size:11px">${lm ? timeAgo(lm.created_at) : ''}</small></button>`; };
  const hiddenDupes = new Set();
  if (mode === 'main') {
    const byPartner = {};
    rows.forEach(r => { if (!r.c.is_group && r.otherId) (byPartner[r.otherId] = byPartner[r.otherId] || []).push(r); });
    Object.values(byPartner).forEach(list => { if (list.length > 1) { const keeper = list.find(r => r.lm) || list[0]; list.forEach(r => { if (r !== keeper && !r.lm) hiddenDupes.add(r.c.id); }); } });
  }
  const shown = rows.filter(r => !hiddenDupes.has(r.c.id) && (mode === 'archived' ? !!r.myRow.archived : mode === 'restricted' ? !!r.myRow.restricted : mode === 'requests' ? (r.isReq && !r.myRow.archived) : (!r.myRow.archived && !r.myRow.restricted && !r.isReq)));
  let html;
  let reqCls = new Map();
  const reqRowsAll = rows.filter(r => r.isReq && !r.myRow.archived);
  if (mode === 'requests' || (mode === 'main' && reqRowsAll.length)) { try { reqCls = await classifyRequests(reqRowsAll, msgs); } catch (e) { reqCls = new Map(); } }
  if (mode === 'requests') {
    shown.forEach(r => r._cls = reqCls.get(r.c.id) || 'other');
    const gK = shown.filter(r => r._cls === 'known'), gO = shown.filter(r => r._cls === 'other'), gS = shown.filter(r => r._cls === 'spam');
    const multi = [gK, gO, gS].filter(g => g.length).length > 1;
    const sec = (g, t, force) => g.length ? ((multi || force) ? `<div style="padding:10px 16px 2px;font-size:12px;font-weight:800;color:var(--faint);letter-spacing:.3px">${t}</div>` : '') + g.map(rowHtml).join('') : '';
    html = (sec(gK, tx('চিনতে পারো', 'You may know')) + sec(gO, tx('অন্যান্য রিকুয়েস্ট', 'Other requests')) + sec(gS, tx('স্প্যাম', 'Spam'), true)) || '<div class="empty">এখানে কিছু নেই</div>';
  } else {
    html = shown.length ? shown.map(rowHtml).join('') : '<div class="empty">এখানে কিছু নেই</div>';
  }
  if (mode === 'main') {
    const nArch = rows.filter(r => r.myRow.archived).length, nRestr = rows.filter(r => r.myRow.restricted).length;
    html += `<button class="chatfoot" onclick="renderChatList('archived')">${ic('archive', 17)} আর্কাইভ করা চ্যাট${nArch ? `<span class="pill" style="margin-left:auto">${bn(nArch)}</span>` : ''}</button>`;
    const nReq = reqRowsAll.filter(r => (reqCls.get(r.c.id) || 'other') !== 'spam').length;
    html += `<button class="chatfoot" onclick="renderChatList('requests')">${ic('msg', 17)} মেসেজ রিকুয়েস্ট${nReq ? `<span class="pill" style="margin-left:auto">${bn(nReq)}</span>` : ''}</button>`;
    html += `<button class="chatfoot" onclick="renderChatList('restricted')">${ic('eyeOff', 17)} রেস্ট্রিক্ট করা চ্যাট${nRestr ? `<span class="pill" style="margin-left:auto">${bn(nRestr)}</span>` : ''}</button>`;
  }
  const clEl = $('#chatList'); if (clEl) clEl.innerHTML = html;
}
/* ---------- notes: 24h mini-status strip on top of the chat list ---------- */
async function renderNotesStrip(){
  const el = $('#notesStrip'); if (!el) return;
  const fids = [...friendIds];
  let fresh = [];
  if (fids.length) {
    const { data } = await sb.from('profiles').select('id,name,avatar_url,note,note_at').in('id', fids);
    (data || []).forEach(p => { profilesCache[p.id] = Object.assign({}, profilesCache[p.id], p); });
    fresh = (data || []).filter(p => p.note && p.note_at && Date.now() - new Date(p.note_at).getTime() < 864e5);
  }
  if (!$('#notesStrip')) return;
  const item = (p, mine) => `<button class="noteitem" onclick="${mine ? 'noteSheet()' : `friendNoteSheet('${p.id}')`}"><span class="notebub usercontent">${p.note ? esc(p.note) : '+'}</span>${avatar(p, 47, 17)}<small>${mine ? 'তোমার নোট' : esc(p.name.split(' ')[0])}</small></button>`;
  el.innerHTML = `<div class="notesstrip">${item(me, true)}${fresh.map(p => item(p, false)).join('')}</div>`;
}
function friendNoteSheet(uid){
  const p = prof(uid);
  sheet(`<div style="text-align:center;padding:6px 0 4px">${avatar(p, 60, 22)}<h3 style="margin:9px 0 4px">${esc(p.name)}</h3>
    <p class="usercontent" style="font-size:15px;line-height:1.6;background:var(--line2);border-radius:16px;padding:13px 15px">${esc(p.note || '')}</p>
    <small style="color:var(--faint)">${p.note_at ? timeAgo(p.note_at) : ''}</small></div>
    <button class="btn block" style="margin-top:12px" onclick="closeSheet();startChat('${uid}')">মেসেজ করো</button>`);
}
function noteSheet(){
  sheet(`<h3>${ic('edit', 18)} তোমার নোট</h3>
    <p style="font-size:13px;color:var(--mut);margin-bottom:10px">বন্ধুরা ২৪ ঘণ্টা এই নোটটা চ্যাটের উপরে দেখবে।</p>
    <textarea class="field" id="noteInput" rows="2" maxlength="80" placeholder="নোট লেখো...">${esc(me.note || '')}</textarea>
    <button class="btn block" onclick="saveNote()">সেভ করো</button>
    ${me.note ? '<button class="btn ghost block" style="margin-top:8px" onclick="clearNote()">নোট মোছো</button>' : ''}`);
}
async function saveNote(){
  const note = $('#noteInput').value.trim();
  const nowIso = new Date().toISOString();
  const { error } = await sb.from('profiles').update({ note, note_at: nowIso }).eq('id', me.id);
  if (error) { toast('নোট সেভ হয়নি'); return; }
  me.note = note; me.note_at = nowIso; profilesCache[me.id] = me;
  closeSheet(); toast('নোট সেভ হয়েছে ✓'); renderNotesStrip();
}
async function clearNote(){
  const { error } = await sb.from('profiles').update({ note: '', note_at: null }).eq('id', me.id);
  if (error) { toast('মোছা যায়নি'); return; }
  me.note = ''; me.note_at = null; profilesCache[me.id] = me;
  closeSheet(); toast('নোট মোছা হয়েছে'); renderNotesStrip();
}
async function findExistingDM(uid){
  const { data: mine } = await sb.from('conversation_members').select('conversation_id').eq('user_id', me.id);
  const myIds = (mine || []).map(r => r.conversation_id);
  if (myIds.length) {
    const { data: theirs } = await sb.from('conversation_members').select('conversation_id').eq('user_id', uid).in('conversation_id', myIds);
    for (const t of (theirs || [])) {
      const { data: conv } = await sb.from('conversations').select('*').eq('id', t.conversation_id).single();
      if (conv && !conv.is_group) return conv.id;
    }
  }
  return null;
}
async function findOrCreateDM(uid, asRequest){
  const existing = await findExistingDM(uid);
  if (existing) return existing;
  const newId = crypto.randomUUID();
  const { error } = await sb.from('conversations').insert({ id: newId, is_group: false });
  if (error) return null;
  await sb.from('conversation_members').insert([{ conversation_id: newId, user_id: me.id, requested: false }, { conversation_id: newId, user_id: uid, requested: !!asRequest }]);
  return newId;
}
async function startChat(uid){
  if (uid === me.id) return;
  const existing = await findExistingDM(uid);
  if (existing) { openChat(existing); return; }
  /* message-privacy (client-level): checked only when a NEW chat would be created */
  const { data: freshProf } = await sb.from('profiles').select('*').eq('id', uid).single();
  if (freshProf) profilesCache[uid] = freshProf;
  const target = freshProf || prof(uid);
  if (target.msg_privacy === 'nobody') { toast('এই ব্যবহারকারী মেসেজ গ্রহণ করেন না'); return; }
  if (target.msg_privacy === 'friends' && !friendIds.has(uid)) { toast('শুধু বন্ধুরা মেসেজ পাঠাতে পারে'); return; }
  const id = await findOrCreateDM(uid, !friendIds.has(uid));
  if (id) openChat(id); else toast('চ্যাট খোলা যায়নি');
}
async function openGroupChat(gid){
  const { data: existing } = await sb.from('conversations').select('id').eq('group_id', gid).maybeSingle();
  if (existing) { openChat(existing.id); return; }
  const newId = crypto.randomUUID();
  const { error } = await sb.from('conversations').insert({ id: newId, is_group: true, group_id: gid });
  if (error) { toast('গ্রুপ চ্যাট খোলা যায়নি'); return; }
  const { data: members } = await sb.from('group_members').select('user_id').eq('group_id', gid);
  await sb.from('conversation_members').insert((members || []).map(m => ({ conversation_id: newId, user_id: m.user_id })));
  openChat(newId);
}
async function openChat(convId){
  curView = 'chat'; activeChat = convId; renderShell();
  replyTarget = null;
  const { data: conv } = await sb.from('conversations').select('*').eq('id', convId).single();
  const { data: members } = await sb.from('conversation_members').select('*').eq('conversation_id', convId);
  await cacheProfiles((members || []).map(m => m.user_id));
  const myRow = (members || []).find(m => m.user_id === me.id) || null;
  const otherRow = (members || []).find(m => m.user_id !== me.id) || null;
  chatMeta = { conv, members: members || [], myRow, otherRow };
  const isReq = !!(myRow && myRow.requested && otherRow && !(conv && conv.is_group) && !friendIds.has(otherRow.user_id));
  chatMeta.isReq = isReq;
  let title = 'চ্যাট', headAv = '';
  chatMeta.group = null;
  if (conv && conv.is_group && conv.group_id) {
    const { data: g } = await sb.from('groups').select('*').eq('id', conv.group_id).single();
    chatMeta.group = g || null;
    title = (g ? g.name : 'গ্রুপ') + ' · গ্রুপ চ্যাট'; headAv = `<span class="av" style="background:#4F46E5;width:38px;height:38px;font-size:15px">${ic('users', 18)}</span>`;
  } else if (otherRow) {
    const p = prof(otherRow.user_id); title = otherRow.nickname || p.name; headAv = avatar(p, 38, 15);
  }
  const th = conv ? chatTheme(conv.theme) : null;
  view().innerHTML = `<div class="view" ${th ? `style="--cgrad:linear-gradient(135deg,${th[1]},${th[2]})"` : ''}>
    <div style="display:flex;gap:10px;align-items:center;padding:12px 16px;background:${th ? `linear-gradient(90deg,${th[1]}30,${th[2]}30)` : 'var(--card)'};border-bottom:1px solid var(--line2);position:sticky;top:57px;z-index:5">
      <button class="icb" style="width:34px;height:34px" onclick="renderChatList()">←</button>${headAv}<b style="font-size:15.5px;flex:1;min-width:0">${esc(title)}</b><button class="icb" style="width:34px;height:34px" onclick="chatSearchSheet()" aria-label="চ্যাটে খোঁজো">${ic('search', 17)}</button><button class="icb" style="width:34px;height:34px" onclick="chatInfoSheet()" aria-label="চ্যাটের তথ্য">${ic('dots', 18)}</button></div>
    ${conv && conv.announcement ? `<div class="annbar">${ic('pin', 13)}<span class="usercontent" style="flex:1;min-width:0">${esc(conv.announcement)}</span></div>` : ''}
    ${isReq ? `<div class="annbar" id="reqBar" style="background:#EEF2FF">${ic('msg', 14)}<span style="flex:1;min-width:0"><b>${esc(prof(otherRow.user_id).name)}</b> তোমাকে মেসেজ পাঠাতে চায়<br><small style="color:var(--mut)">গ্রহণ করলে চ্যাটটি মূল লিস্টে যাবে</small></span><button class="btn sm" onclick="acceptRequest('${convId}')">গ্রহণ করো</button><button class="btn ghost sm" onclick="deleteRequest('${convId}')">মুছো</button><button class="btn ghost sm" style="color:var(--danger)" onclick="blockRequest('${otherRow.user_id}','${convId}')">ব্লক</button></div>` : ''}
    <div id="typingLine" style="display:none;padding:5px 16px;font-size:12px;color:var(--mut);background:var(--card);border-bottom:1px solid var(--line2)"></div>
    <div ${th ? `style="background:linear-gradient(165deg,${th[1]}24,${th[2]}24)"` : ''}><div id="msgList" style="padding:10px 0 4px"><div class="empty">লোড হচ্ছে...</div></div></div>
    <div id="replyBar"></div>
    <div class="chatbar"><button class="icb" onclick="chatPollSheet()" aria-label="পোল">${ic('chart', 18)}</button><button class="icb" onclick="stickerSheet('${convId}')" aria-label="স্টিকার">${I.smile}</button><label class="icb" style="cursor:pointer" aria-label="ফাইল পাঠাও">${ic('clip')}<input type="file" style="display:none" onchange="sendFileMsg('${convId}',this)"></label><label class="icb" style="cursor:pointer" aria-label="ভয়েস মেসেজ">${I.mic}<input type="file" accept="audio/*" style="display:none" onchange="sendVoiceMsg('${convId}',this)"></label><input id="msgInput" placeholder="মেসেজ লেখো..." oninput="onMsgInput()" onkeydown="if(event.key==='Enter')sendMsg('${convId}')"><button class="quickbtn" onclick="sendQuickEmoji('${convId}')" aria-label="কুইক রিঅ্যাকশন">${esc((chatMeta.myRow && chatMeta.myRow.quick_emoji) || '❤️')}</button><button class="send" onclick="sendMsg('${convId}')">${ic('send', 18)}</button></div></div>`;
  if (!me.hide_reads && !isReq) {
    const nowIso = new Date().toISOString();
    sb.from('conversation_members').update({ last_read_at: nowIso }).eq('conversation_id', convId).eq('user_id', me.id).then(() => {});
    if (myRow) myRow.last_read_at = nowIso;
  }
  const { data: msgs } = await sb.from('messages').select('*').eq('conversation_id', convId).order('created_at', { ascending: false }).limit(200);
  chatMsgs = (msgs || []).reverse();
  chatMsgMap = {}; chatMsgs.forEach(m => chatMsgMap[m.id] = m);
  chatReactions = {};
  await loadReactions(chatMsgs.map(m => m.id));
  chatPollVotes = {};
  await loadPollVotes(chatMsgs.filter(m => pollOf(m)).map(m => m.id));
  renderMsgList();
  if (chatChannel) sb.removeChannel(chatChannel);
  chatChannel = sb.channel('chat-' + convId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: 'conversation_id=eq.' + convId }, payload => {
      if (activeChat !== convId) return;
      const m = payload.new;
      if (!m || chatMsgMap[m.id]) return;
      chatMsgs.push(m); chatMsgMap[m.id] = m;
      const box = $('#msgList'); if (!box) return;
      if (box.querySelector('.empty')) { renderMsgList(); return; }
      const seen = box.querySelector('.seenlbl'); if (seen) seen.remove();
      box.insertAdjacentHTML('beforeend', msgHtml(m));
      window.scrollTo(0, document.body.scrollHeight);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: 'conversation_id=eq.' + convId }, payload => {
      if (activeChat !== convId) return;
      const m = payload.new; if (!m) return;
      const i = chatMsgs.findIndex(x => x.id === m.id);
      if (i >= 0) { chatMsgs[i] = m; chatMsgMap[m.id] = m; renderMsgList(false); }
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages', filter: 'conversation_id=eq.' + convId }, payload => {
      if (activeChat !== convId) return;
      const id = payload.old && payload.old.id; if (!id) return;
      chatMsgs = chatMsgs.filter(x => x.id !== id); delete chatMsgMap[id];
      if (replyTarget && replyTarget.id === id) clearReply();
      renderMsgList(false);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, async payload => {
      if (activeChat !== convId) return;
      const mid = (payload.new && payload.new.message_id) || (payload.old && payload.old.message_id);
      if (!mid || !chatMsgMap[mid]) return;
      await loadReactions([mid]);
      renderMsgList(false);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_poll_votes' }, async payload => {
      if (activeChat !== convId) return;
      const mid = (payload.new && payload.new.message_id) || (payload.old && payload.old.message_id);
      if (!mid || !chatMsgMap[mid]) return;
      await loadPollVotes([mid]);
      renderMsgList(false);
    }).subscribe();
  if (typingChannel && typingTopic !== convId) { sb.removeChannel(typingChannel); typingChannel = null; }
  if (!typingChannel) {
    typingTopic = convId;
    typingChannel = sb.channel('typing-' + convId, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (!payload || payload.user === me.id || activeChat !== convId) return;
        showTyping(payload.name || 'বন্ধু');
      }).subscribe();
  }
  const inp = $('#msgInput'); if (inp) inp.focus();
}
function snippetOf(body){
  if (!body) return '';
  if (body.startsWith(POLL_PREFIX)) { const p = (() => { try { return JSON.parse(body.slice(POLL_PREFIX.length)); } catch (e) { return null; } })(); return '🗳 ' + (p && p.q ? p.q : tx('পোল', 'Poll')); }
  if (body.startsWith('🎧AUDIO:')) return '🎧 ' + tx('ভয়েস মেসেজ', 'Voice message');
  if (body.startsWith('📎FILE:')) { const r = body.slice(7); const i = r.indexOf('|'); return '📎 ' + (i >= 0 ? r.slice(i + 1) : tx('ফাইল', 'File')); }
  const chars = [...body];
  return chars.length > 60 ? chars.slice(0, 60).join('') + '…' : body;
}
function quoteHtml(m){
  if (!m.reply_to) return '';
  const t = chatMsgMap[m.reply_to];
  if (!t) return '';
  return `<span class="qbox"><b>${esc(prof(t.sender_id).name)}</b>${esc(snippetOf(t.body))}</span>`;
}
function rxnHtml(m){
  const r = chatReactions[m.id]; if (!r) return '';
  const chips = Object.entries(r).filter(([, v]) => v.count > 0)
    .map(([e, v]) => `<button class="rxn ${v.mine ? 'mine' : ''}" data-mid="${m.id}" data-e="${esc(e)}" onclick="event.stopPropagation();rxnChip(this)">${esc(e)} ${bn(v.count)}</button>`).join('');
  return chips ? `<span class="rxns">${chips}</span>` : '';
}
function rxnChip(el){ toggleReaction(el.dataset.mid, el.dataset.e); }
function seenHtml(){
  if (!chatMsgs.length || !chatMeta.members.length) return '';
  const mine = [...chatMsgs].reverse().find(m => m.sender_id === me.id);
  if (!mine) return '';
  let seenAt = null;
  for (const o of chatMeta.members) {
    if (o.user_id === me.id || !o.last_read_at) continue;
    const op = profilesCache[o.user_id];
    if (op && op.hide_reads) continue;
    if (new Date(o.last_read_at) >= new Date(mine.created_at)) seenAt = o.last_read_at;
  }
  return seenAt ? `<div class="seenlbl">দেখা হয়েছে · ${timeAgo(seenAt)}</div>` : '';
}
function renderMsgList(scroll = true){
  const box = $('#msgList'); if (!box) return;
  let list = chatMsgs;
  if (chatMeta.conv && chatMeta.conv.disappear) list = list.filter(m => Date.now() - new Date(m.created_at).getTime() < 864e5);
  let html = '';
  if (chatMeta.conv && chatMeta.conv.disappear) html += '<div class="empty" style="padding:6px 16px;font-size:12px">ডিসঅ্যাপিয়ারিং চালু — ২৪ ঘণ্টার পুরনো মেসেজ দেখা যায় না</div>';
  html += list.length ? list.map(msgHtml).join('') : '<div class="empty">প্রথম মেসেজটা পাঠাও 👋</div>';
  html += seenHtml();
  box.innerHTML = html;
  if (scroll) window.scrollTo(0, document.body.scrollHeight);
}
function pollCardHtml(m, poll){
  const v = chatPollVotes[m.id] || { counts: {}, mine: null, total: 0 };
  const total = v.total || 0;
  const opts = poll.options.map((opt, i) => {
    const n = v.counts[i] || 0;
    const pct = total ? Math.round(n * 100 / total) : 0;
    return `<button class="cpopt" onclick="event.stopPropagation();voteChatPoll('${m.id}',${i})"><span class="cpfill" style="width:${pct}%"></span><span class="cplabel">${esc(opt)}${v.mine === i ? ' ✓' : ''}</span><span class="cppct">${bn(n)} · ${bn(pct)}%</span></button>`;
  }).join('');
  return `<div class="cpoll"><div class="cpq">🗳 ${esc(poll.q)}</div>${opts}<div class="cptotal">${bn(total)} ${tx('টি ভোট', total === 1 ? 'vote' : 'votes')}</div></div>`;
}
function msgHtml(m){
  const mine = m.sender_id === me.id;
  const edited = m.edited_at ? tx(' · সম্পাদিত', ' · edited') : '';
  const tail = `<small>${timeAgo(m.created_at)}${edited}</small>`;
  const q = quoteHtml(m), rx = rxnHtml(m);
  const poll = pollOf(m);
  if (poll) return `<div class="msg ${mine ? 'me' : ''}" id="m-${m.id}" onclick="msgTap(event,'${m.id}')">${q}${pollCardHtml(m, poll)}${rx}${tail}</div>`;
  if (chatMeta && chatMeta.isReq && !mine && m.body && (m.body.startsWith('🎧AUDIO:') || m.body.startsWith('📎FILE:'))) return `<div class="msg" id="m-${m.id}">${q}<span style="display:flex;gap:8px;align-items:center">${ic('lock', 17)}<span>${tx('মিডিয়া লুকানো আছে — দেখতে রিকুয়েস্ট গ্রহণ করো', 'Media hidden — accept the request to view')}</span></span>${tail}</div>`;
  if (m.body && m.body.startsWith('🎧AUDIO:')) return `<div class="msg ${mine ? 'me' : ''}" id="m-${m.id}" onclick="msgTap(event,'${m.id}')">${q}<audio controls src="${esc(m.body.slice(8))}" style="max-width:210px;height:36px"></audio>${rx}${tail}</div>`;
  if (m.body && m.body.startsWith('📎FILE:')) {
    const rest = m.body.slice(7); const bar = rest.indexOf('|');
    const url = bar >= 0 ? rest.slice(0, bar) : rest; const name = bar >= 0 ? rest.slice(bar + 1) : tx('ফাইল', 'File');
    return `<div class="msg ${mine ? 'me' : ''}" id="m-${m.id}" onclick="msgTap(event,'${m.id}')">${q}<a href="${esc(url)}" target="_blank" rel="noopener" style="display:flex;gap:9px;align-items:center;color:inherit;text-decoration:none">${ic('file', 24)}<span style="min-width:0"><b style="display:block;font-size:13px;word-break:break-all">${esc(name)}</b><span style="font-size:11px;opacity:.75">${tx('ডাউনলোড করতে চাপ দাও', 'Tap to download')}</span></span></a>${rx}${tail}</div>`;
  }
  const sticker = m.body && [...m.body].length <= 3 && /\p{Extended_Pictographic}/u.test(m.body);
  if (sticker) return `<div class="msg ${mine ? 'me' : ''}" id="m-${m.id}" onclick="msgTap(event,'${m.id}')" style="background:none;box-shadow:none;font-size:52px;padding:2px">${q}${esc(m.body)}${rx}<small style="font-size:10px">${timeAgo(m.created_at)}${edited}</small></div>`;
  return `<div class="msg ${mine ? 'me' : ''}" id="m-${m.id}" onclick="msgTap(event,'${m.id}')">${q}${esc(m.body)}${rx}${tail}</div>`;
}
/* ---------- message actions: sheet / reply / edit / delete / reactions ---------- */
function msgTap(ev, mid){
  if (ev.target.closest('audio, a, button, input, textarea')) return;
  msgActions(mid);
}
function msgActions(mid){
  const m = chatMsgMap[mid]; if (!m) return;
  const mine = m.sender_id === me.id;
  const isText = m.body && !m.body.startsWith('🎧AUDIO:') && !m.body.startsWith('📎FILE:') && !pollOf(m);
  const RX = ['❤️', '👍', '😂', '😮', '😢', '🙏'];
  sheet(`<h3>${ic('msg', 18)} মেসেজ অপশন</h3>
    <div style="display:flex;justify-content:space-around;padding:4px 0 12px">${RX.map(e => `<button style="font-size:27px;background:none;border:none;cursor:pointer;padding:4px" onclick="closeSheet();toggleReaction('${mid}','${e}')">${e}</button>`).join('')}</div>
    <button class="menu-item" onclick="setReply('${mid}')">${ic('share')} রিপ্লাই</button>
    ${isText ? `<button class="menu-item" onclick="copyMsg('${mid}')">${ic('file')} কপি</button>` : ''}
    ${mine && isText ? `<button class="menu-item" onclick="editMsgSheet('${mid}')">${ic('edit')} সম্পাদনা</button>` : ''}
    ${mine ? `<button class="menu-item" style="color:var(--danger)" onclick="deleteMsg('${mid}')">${ic('trash')} সবার জন্য মোছো</button>` : ''}`);
}
async function toggleReaction(mid, emoji){
  const cur = (chatReactions[mid] || {})[emoji];
  if (cur && cur.mine) await sb.from('message_reactions').delete().eq('message_id', mid).eq('user_id', me.id);
  else await sb.from('message_reactions').upsert({ message_id: mid, user_id: me.id, emoji }, { onConflict: 'message_id,user_id' });
  await loadReactions([mid]);
  renderMsgList(false);
}
async function loadReactions(ids){
  if (!ids || !ids.length) return;
  const { data } = await sb.from('message_reactions').select('*').in('message_id', ids);
  const grouped = {};
  (data || []).forEach(r => {
    if (!grouped[r.message_id]) grouped[r.message_id] = {};
    const g = grouped[r.message_id];
    if (!g[r.emoji]) g[r.emoji] = { count: 0, mine: false };
    g[r.emoji].count++; if (r.user_id === me.id) g[r.emoji].mine = true;
  });
  ids.forEach(id => { chatReactions[id] = grouped[id] || {}; });
}
async function loadPollVotes(ids){
  if (!ids || !ids.length) return;
  const { data } = await sb.from('chat_poll_votes').select('*').in('message_id', ids);
  const grouped = {};
  (data || []).forEach(r => {
    if (!grouped[r.message_id]) grouped[r.message_id] = { counts: {}, mine: null, total: 0 };
    const g = grouped[r.message_id];
    g.counts[r.choice] = (g.counts[r.choice] || 0) + 1; g.total++;
    if (r.user_id === me.id) g.mine = r.choice;
  });
  ids.forEach(id => { chatPollVotes[id] = grouped[id] || { counts: {}, mine: null, total: 0 }; });
}
async function voteChatPoll(mid, idx){
  const { error } = await sb.from('chat_poll_votes').upsert({ message_id: mid, user_id: me.id, choice: idx }, { onConflict: 'message_id,user_id' });
  if (error) { toast('ভোট দেওয়া যায়নি'); return; }
  await loadPollVotes([mid]);
  renderMsgList(false);
}
function chatPollSheet(){
  const convId = activeChat; if (!convId) return;
  sheet(`<h3>${ic('chart', 18)} নতুন পোল</h3>
    <input class="field" id="cpQ" placeholder="প্রশ্ন লেখো">
    <input class="field cpOpt" placeholder="অপশন ১">
    <input class="field cpOpt" placeholder="অপশন ২">
    <input class="field cpOpt" placeholder="অপশন ৩ (ঐচ্ছিক)">
    <input class="field cpOpt" placeholder="অপশন ৪ (ঐচ্ছিক)">
    <button class="btn block" onclick="sendChatPoll('${convId}')">পোল পাঠাও</button>`);
}
async function sendChatPoll(convId){
  const q = $('#cpQ').value.trim();
  const options = [...document.querySelectorAll('.cpOpt')].map(i => i.value.trim()).filter(Boolean);
  if (!q) { toast('প্রশ্ন লেখো'); return; }
  if (options.length < 2) { toast('কমপক্ষে ২টা অপশন দাও'); return; }
  const { error } = await sb.from('messages').insert({ conversation_id: convId, sender_id: me.id, body: POLL_PREFIX + JSON.stringify({ q, options }) });
  if (error) { toast('পোল পাঠানো যায়নি'); return; }
  closeSheet(); toast('পোল পাঠানো হয়েছে ✓');
  const { data: members } = await sb.from('conversation_members').select('*').eq('conversation_id', convId);
  (members || []).filter(m => m.user_id !== me.id && !m.muted && !m.restricted && !m.requested).forEach(m => notify(m.user_id, 'message', null, convId));
}
/* ---------- in-chat search ---------- */
function chatSearchSheet(){
  sheet(`<h3>${ic('search', 18)} চ্যাটে খোঁজো</h3>
    <input class="field" id="csInput" placeholder="যা খুঁজছ লেখো..." oninput="chatSearchRun(this.value)">
    <div id="csResults"><div class="empty">এই চ্যাটের লেখা মেসেজগুলোর মধ্যে খোঁজো</div></div>`);
  const inp = $('#csInput'); if (inp) inp.focus();
}
function chatSearchRun(q){
  const box = $('#csResults'); if (!box) return;
  const needle = (q || '').trim().toLowerCase();
  if (!needle) { box.innerHTML = '<div class="empty">এই চ্যাটের লেখা মেসেজগুলোর মধ্যে খোঁজো</div>'; return; }
  const hits = chatMsgs.filter(m => {
    if (chatMeta.conv && chatMeta.conv.disappear && Date.now() - new Date(m.created_at).getTime() > 864e5) return false;
    const b = m.body || '';
    if (!b || b.startsWith('🎧AUDIO:') || b.startsWith('📎FILE:') || pollOf(m)) return false;
    if ([...b].length <= 3 && /\p{Extended_Pictographic}/u.test(b)) return false;
    return b.toLowerCase().includes(needle);
  }).slice(-30).reverse();
  box.innerHTML = hits.length ? hits.map(m => `<button class="menu-item" onclick="gotoMsg('${m.id}')"><span style="flex:1;min-width:0"><b style="font-size:13px">${esc(prof(m.sender_id).name)}</b><br><span style="font-size:13px;color:var(--mut)">${esc(snippetOf(m.body))}</span></span><small style="color:var(--faint);font-size:11px;flex:none">${timeAgo(m.created_at)}</small></button>`).join('') : '<div class="empty">কোনো ফলাফল নেই</div>';
}
async function gotoMsg(mid){
  closeSheet();
  let el = document.getElementById('m-' + mid);
  if (!el && activeChat) { await openChat(activeChat); el = document.getElementById('m-' + mid); }
  if (!el) { toast('পাওয়া যায়নি'); return; }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => { const e2 = document.getElementById('m-' + mid); if (e2) e2.classList.remove('flash'); }, 1800);
}
/* ---------- quick-reaction emoji ---------- */
async function sendQuickEmoji(convId){
  const e = (chatMeta.myRow && chatMeta.myRow.quick_emoji) || '❤️';
  const { error } = await sb.from('messages').insert({ conversation_id: convId, sender_id: me.id, body: e });
  if (error) toast('যায়নি'); else notifyChat(convId);
}
function setReply(mid){
  const m = chatMsgMap[mid]; if (!m) return;
  replyTarget = m; closeSheet(); renderReplyBar();
  const inp = $('#msgInput'); if (inp) inp.focus();
}
function clearReply(){ replyTarget = null; renderReplyBar(); }
function renderReplyBar(){
  const bar = $('#replyBar'); if (!bar) return;
  if (!replyTarget) { bar.innerHTML = ''; return; }
  bar.innerHTML = `<div style="display:flex;gap:8px;align-items:center;padding:8px 14px;background:var(--line2);border-top:1px solid var(--line);font-size:12.5px"><span style="flex:1;min-width:0;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><b style="color:var(--ink2)">${esc(prof(replyTarget.sender_id).name)}</b> · ${esc(snippetOf(replyTarget.body))}</span><button class="icb" style="width:28px;height:28px;flex:none" onclick="clearReply()" aria-label="বন্ধ করো">${ic('x', 13)}</button></div>`;
}
async function copyMsg(mid){
  const m = chatMsgMap[mid]; if (!m) return;
  try { await navigator.clipboard.writeText(m.body); } catch (e) {}
  closeSheet(); toast('কপি হয়েছে');
}
function editMsgSheet(mid){
  const m = chatMsgMap[mid]; if (!m) return;
  sheet(`<h3>${ic('edit', 18)} মেসেজ সম্পাদনা</h3>
    <textarea class="field" id="editMsgBody" rows="3">${esc(m.body)}</textarea>
    <button class="btn block" onclick="saveEditMsg('${mid}')">সেভ করো</button>`);
}
async function saveEditMsg(mid){
  const body = $('#editMsgBody').value.trim();
  if (!body) { toast('খালি মেসেজ হবে না'); return; }
  const nowIso = new Date().toISOString();
  const { error } = await sb.from('messages').update({ body, edited_at: nowIso }).eq('id', mid);
  if (error) { toast('বদলানো যায়নি'); return; }
  const m = chatMsgMap[mid];
  if (m) { m.body = body; m.edited_at = nowIso; }
  closeSheet(); renderMsgList(false); toast('সম্পাদনা হয়েছে ✓');
}
async function deleteMsg(mid){
  const { error } = await sb.from('messages').delete().eq('id', mid);
  if (error) { toast('মোছা যায়নি'); return; }
  chatMsgs = chatMsgs.filter(x => x.id !== mid);
  delete chatMsgMap[mid];
  if (replyTarget && replyTarget.id === mid) clearReply();
  closeSheet(); renderMsgList(false); toast('মেসেজ মোছা হয়েছে');
}
/* ---------- chat info sheet: nickname / theme / pin / mute / disappear ---------- */
function chatInfoSheet(){
  const { conv, myRow, otherRow } = chatMeta;
  if (!conv) return;
  const nickRow = conv.is_group ? myRow : otherRow;
  const cur = conv.theme || '';
  const isGroupCreator = !!(conv.is_group && chatMeta.group && chatMeta.group.created_by === me.id);
  const QUICK_EMOJIS = ['❤️', '😂', '😮', '😢', '👍', '🙏', '🔥', '😍'];
  const quickCur = (myRow && myRow.quick_emoji) || '❤️';
  sheet(`<h3>${ic('info', 18)} চ্যাটের তথ্য</h3>
    <button class="menu-item" onclick="setNicknameSheet()">${ic('edit')} ডাকনাম দাও${nickRow && nickRow.nickname ? `<span style="margin-left:auto" class="pill">${esc(nickRow.nickname)}</span>` : ''}</button>
    <div class="seclabel" style="margin:12px 0 4px">চ্যাটের থিম</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:4px 0 8px">
      <button onclick="setChatTheme('')" style="background:none;border:none;cursor:pointer;text-align:center;padding:0"><span style="display:block;width:40px;height:40px;margin:0 auto;border-radius:50%;background:var(--line2);border:2px ${cur === '' ? 'solid var(--acc)' : 'solid var(--line)'}"></span><small style="font-size:11px;color:var(--mut)">ডিফল্ট</small></button>
      ${CHAT_THEMES.map(([k, c1, c2, label]) => `<button onclick="setChatTheme('${k}')" style="background:none;border:none;cursor:pointer;text-align:center;padding:0"><span style="display:block;width:40px;height:40px;margin:0 auto;border-radius:50%;background:linear-gradient(135deg,${c1},${c2});border:2px ${cur === k ? 'solid var(--acc)' : 'solid transparent'}"></span><small style="font-size:11px;color:var(--mut)">${label}</small></button>`).join('')}
    </div>
    <button class="menu-item" onclick="toggleChatPin()">${ic('pin')} ${myRow && myRow.pinned ? 'পিন সরাও' : 'পিন করো'}</button>
    <button class="menu-item" onclick="toggleChatMute()">${ic('mute')} ${myRow && myRow.muted ? 'আনমিউট' : 'মিউট'}</button>
    <button class="menu-item" onclick="toggleDisappear()">${ic('clock')} ডিসঅ্যাপিয়ারিং মেসেজ<span style="margin-left:auto" class="pill">${conv.disappear ? 'চালু' : 'বন্ধ'}</span></button>
    <button class="menu-item" onclick="chatMediaSheet()">${ic('img')} এই চ্যাটের মিডিয়া</button>
    <button class="menu-item" onclick="toggleChatArchive()">${ic('archive')} ${myRow && myRow.archived ? 'আর্কাইভ থেকে তোলো' : 'আর্কাইভ করো'}</button>
    ${!conv.is_group ? `<button class="menu-item" onclick="toggleChatRestrict()">${ic('eyeOff')} ${myRow && myRow.restricted ? 'রেস্ট্রিক্ট সরাও' : 'রেস্ট্রিক্ট করো'}<span style="margin-left:auto" class="pill">${myRow && myRow.restricted ? 'চালু' : 'বন্ধ'}</span></button>` : ''}
    <div class="seclabel" style="margin:12px 0 4px">কুইক রিঅ্যাকশন</div>
    <div style="display:flex;justify-content:space-between;padding:2px 0 8px">${QUICK_EMOJIS.map(e => `<button style="font-size:25px;background:${e === quickCur ? 'var(--line2)' : 'none'};border:${e === quickCur ? '2px solid var(--acc)' : '2px solid transparent'};border-radius:50%;width:42px;height:42px;cursor:pointer" onclick="setQuickEmoji('${e}')">${e}</button>`).join('')}</div>
    ${isGroupCreator ? `
    <div class="seclabel" style="margin:12px 0 4px">গ্রুপ অ্যাডমিন</div>
    <button class="menu-item" onclick="announcementSheet()">${ic('pin')} ঘোষণা${conv.announcement ? `<span style="margin-left:auto" class="pill">চালু</span>` : ''}</button>
    <div class="seclabel" style="margin:12px 0 4px">সদস্যরা</div>
    ${chatMeta.members.map(mb => { const p = prof(mb.user_id); return `<div class="menu-item" style="cursor:default">${avatar(p, 32, 13)}<span style="flex:1;min-width:0">${esc(p.name)}${mb.user_id === me.id ? ' (তুমি)' : ''}</span>${mb.user_id !== me.id ? `<button class="btn ghost sm" onclick="removeChatMember('${mb.user_id}')">সরাও</button>` : ''}</div>`; }).join('')}` : ''}`);
}
async function toggleChatArchive(){
  const { conv, myRow } = chatMeta; if (!myRow) { toast('করা যায়নি'); return; }
  const next = !myRow.archived;
  const { error } = await sb.from('conversation_members').update({ archived: next }).eq('conversation_id', conv.id).eq('user_id', me.id);
  if (error) { toast('করা যায়নি'); return; }
  myRow.archived = next;
  closeSheet(); toast(next ? 'আর্কাইভ করা হয়েছে' : 'আর্কাইভ থেকে তোলা হয়েছে');
  renderChatList();
}
async function toggleChatRestrict(){
  const { conv, myRow } = chatMeta; if (!myRow) { toast('করা যায়নি'); return; }
  const next = !myRow.restricted;
  const { error } = await sb.from('conversation_members').update({ restricted: next }).eq('conversation_id', conv.id).eq('user_id', me.id);
  if (error) { toast('করা যায়নি'); return; }
  myRow.restricted = next;
  closeSheet(); toast(next ? 'রেস্ট্রিক্ট করা হয়েছে' : 'রেস্ট্রিক্ট সরানো হয়েছে');
  if (next) renderChatList();
}
async function setQuickEmoji(e){
  const { conv, myRow } = chatMeta; if (!myRow) { toast('করা যায়নি'); return; }
  const { error } = await sb.from('conversation_members').update({ quick_emoji: e }).eq('conversation_id', conv.id).eq('user_id', me.id);
  if (error) { toast('বদলানো যায়নি'); return; }
  myRow.quick_emoji = e;
  closeSheet(); toast('কুইক রিঅ্যাকশন বদলানো হয়েছে');
  openChat(conv.id);
}
function announcementSheet(){
  const { conv } = chatMeta; if (!conv) return;
  sheet(`<h3>${ic('pin', 18)} ঘোষণা</h3>
    <p style="font-size:13px;color:var(--mut);margin-bottom:10px">ঘোষণাটা চ্যাটের উপরে পিন হয়ে থাকবে — সব সদস্য দেখবে।</p>
    <textarea class="field" id="annInput" rows="2" maxlength="200" placeholder="ঘোষণা লেখো...">${esc(conv.announcement || '')}</textarea>
    <button class="btn block" onclick="saveAnnouncement()">সেভ করো</button>
    ${conv.announcement ? '<button class="btn ghost block" style="margin-top:8px" onclick="clearAnnouncement()">ঘোষণা মোছো</button>' : ''}`);
}
async function saveAnnouncement(){
  const { conv } = chatMeta; if (!conv) return;
  const text = $('#annInput').value.trim();
  const { error } = await sb.from('conversations').update({ announcement: text }).eq('id', conv.id);
  if (error) { toast('ঘোষণা সেভ হয়নি'); return; }
  conv.announcement = text;
  closeSheet(); toast('ঘোষণা সেভ হয়েছে ✓');
  openChat(conv.id);
}
async function clearAnnouncement(){
  const { conv } = chatMeta; if (!conv) return;
  const { error } = await sb.from('conversations').update({ announcement: '' }).eq('id', conv.id);
  if (error) { toast('মোছা যায়নি'); return; }
  conv.announcement = '';
  closeSheet(); toast('ঘোষণা মোছা হয়েছে');
  openChat(conv.id);
}
async function removeChatMember(uid){
  const { conv } = chatMeta; if (!conv) return;
  const { error } = await sb.from('conversation_members').delete().eq('conversation_id', conv.id).eq('user_id', uid);
  if (error) { toast('সরানো যায়নি'); return; }
  chatMeta.members = chatMeta.members.filter(m => m.user_id !== uid);
  toast('সদস্য সরানো হয়েছে');
  chatInfoSheet();
}
/* ---------- chat memories: all media shared in this conversation ---------- */
async function chatMediaSheet(){
  const { conv } = chatMeta; if (!conv) return;
  sheet(`<h3>${ic('img', 18)} এই চ্যাটের মিডিয়া</h3><div id="cmBody"><div class="empty">লোড হচ্ছে...</div></div>`);
  const { data } = await sb.from('messages').select('*').eq('conversation_id', conv.id).order('created_at', { ascending: false }).limit(500);
  const el = $('#cmBody'); if (!el) return;
  const media = (data || []).map(m => ({ m, md: chatMediaOf(m) })).filter(x => x.md && (x.md.type === 'image' || x.md.type === 'audio'));
  if (!media.length) { el.innerHTML = '<div class="empty">কোনো মিডিয়া নেই</div>'; return; }
  const imgs = media.filter(x => x.md.type === 'image');
  const voices = media.filter(x => x.md.type === 'audio');
  el.innerHTML =
    (imgs.length ? `<div class="mediagrid">${imgs.map(x => `<a href="${esc(x.md.url)}" target="_blank" rel="noopener"><img src="${esc(x.md.url)}" loading="lazy" alt=""></a>`).join('')}</div>` : '') +
    (voices.length ? `<div class="seclabel" style="margin:10px 0 4px">ভয়েস মেসেজ</div>` + voices.map(x => `<div style="display:flex;align-items:center;gap:9px;padding:6px 0;border-bottom:1px solid var(--line2)"><span style="flex:1;min-width:0;font-size:12.5px;color:var(--mut)">${esc(prof(x.m.sender_id).name)} · ${timeAgo(x.m.created_at)}</span><audio controls src="${esc(x.md.url)}" style="max-width:190px;height:34px"></audio></div>`).join('') : '');
}
function setNicknameSheet(){
  const { conv, myRow, otherRow } = chatMeta;
  const row = conv.is_group ? myRow : otherRow;
  if (!row) { toast('ডাকনাম দেওয়া যাবে না'); return; }
  sheet(`<h3>${ic('edit', 18)} ডাকনাম দাও</h3>
    <input class="field" id="nickInput" placeholder="ডাকনাম" value="${esc(row.nickname || '')}">
    <button class="btn block" onclick="saveNickname()">সেভ করো</button>`);
}
async function saveNickname(){
  const { conv, myRow, otherRow } = chatMeta;
  const row = conv.is_group ? myRow : otherRow;
  if (!row) return;
  const nick = $('#nickInput').value.trim();
  const { error } = await sb.from('conversation_members').update({ nickname: nick }).eq('conversation_id', conv.id).eq('user_id', row.user_id);
  if (error) { toast('ডাকনাম দেওয়া যায়নি'); return; }
  row.nickname = nick;
  closeSheet(); toast('ডাকনাম দেওয়া হয়েছে ✓');
  openChat(conv.id);
}
async function setChatTheme(key){
  const { conv } = chatMeta; if (!conv) return;
  const { error } = await sb.from('conversations').update({ theme: key }).eq('id', conv.id);
  if (error) { toast('থিম বদলানো যায়নি'); return; }
  conv.theme = key;
  closeSheet(); toast('থিম বদলানো হয়েছে');
  openChat(conv.id);
}
async function toggleChatPin(){
  const { conv, myRow } = chatMeta; if (!myRow) { toast('করা যায়নি'); return; }
  const next = !myRow.pinned;
  const { error } = await sb.from('conversation_members').update({ pinned: next }).eq('conversation_id', conv.id).eq('user_id', me.id);
  if (error) { toast('করা যায়নি'); return; }
  myRow.pinned = next;
  closeSheet(); toast(next ? 'পিন করা হয়েছে' : 'পিন সরানো হয়েছে');
}
async function toggleChatMute(){
  const { conv, myRow } = chatMeta; if (!myRow) { toast('করা যায়নি'); return; }
  const next = !myRow.muted;
  const { error } = await sb.from('conversation_members').update({ muted: next }).eq('conversation_id', conv.id).eq('user_id', me.id);
  if (error) { toast('করা যায়নি'); return; }
  myRow.muted = next;
  closeSheet(); toast(next ? 'মিউট করা হয়েছে' : 'আনমিউট করা হয়েছে');
}
async function toggleDisappear(){
  const { conv } = chatMeta; if (!conv) return;
  const next = !conv.disappear;
  const { error } = await sb.from('conversations').update({ disappear: next }).eq('id', conv.id);
  if (error) { toast('করা যায়নি'); return; }
  conv.disappear = next;
  closeSheet(); toast(next ? 'ডিসঅ্যাপিয়ারিং চালু হয়েছে' : 'ডিসঅ্যাপিয়ারিং বন্ধ হয়েছে');
  openChat(conv.id);
}
/* ---------- typing ---------- */
function onMsgInput(){
  const now = Date.now();
  if (now - lastTypingAt < 2500) return;
  lastTypingAt = now;
  if (typingChannel) { try { typingChannel.send({ type: 'broadcast', event: 'typing', payload: { user: me.id, name: me.name } }); } catch (e) {} }
  if (presenceChannel && activeChat) {
    try { presenceChannel.track({ user_id: me.id, name: me.name, typing: activeChat }); } catch (e) {}
    if (typingClearTimer) clearTimeout(typingClearTimer);
    typingClearTimer = setTimeout(() => { if (presenceChannel) { try { presenceChannel.track({ user_id: me.id }); } catch (e) {} } }, 3500);
  }
}
function showTyping(name){
  const el = $('#typingLine'); if (!el) return;
  el.textContent = name + ' লিখছে...';
  el.style.display = 'block';
  if (typingHideTimer) clearTimeout(typingHideTimer);
  typingHideTimer = setTimeout(() => { const e2 = $('#typingLine'); if (e2) e2.style.display = 'none'; }, 3000);
}
function showPhoto(btn){ const img = document.createElement('img'); img.className = 'pimg'; img.src = btn.dataset.photosrc || ''; img.alt = ''; btn.replaceWith(img); }
function stickerSheet(convId){
  const stickers = ['😂','❤️','😍','👍','🔥','🥰','😎','🤣','😭','🙏','💯','🎉','😴','🤔','👏','🌹'];
  sheet(`<h3>স্টিকার পাঠাও</h3><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">${stickers.map(s => `<button style="font-size:38px;background:none;border:none;cursor:pointer;padding:6px" onclick="sendSticker('${convId}','${s}')">${s}</button>`).join('')}</div>`);
}
async function sendSticker(convId, s){
  closeSheet();
  const { error } = await sb.from('messages').insert({ conversation_id: convId, sender_id: me.id, body: s });
  if (error) toast('যায়নি'); else notifyChat(convId);
}
async function uploadFile(file){
  if (!file) return '';
  const ext = ((file.name || '').split('.').pop() || 'bin').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'bin';
  const path = me.id + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  const { error } = await sb.storage.from('media').upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (error) { toast('ফাইল আপলোড হয়নি'); return ''; }
  return sb.storage.from('media').getPublicUrl(path).data.publicUrl;
}
async function sendFileMsg(convId, input){
  const f = input.files[0]; input.value = '';
  if (!f) return;
  if (f.size > 10 * 1024 * 1024) { toast('ফাইল ১০MB-এর বেশি হতে পারবে না'); return; }
  toast('ফাইল আপলোড হচ্ছে...');
  const url = await uploadFile(f);
  if (!url) { toast('আপলোড হয়নি'); return; }
  const name = f.name.replace(/\|/g, ' ');
  const { error } = await sb.from('messages').insert({ conversation_id: convId, sender_id: me.id, body: '📎FILE:' + url + '|' + name });
  if (error) toast('যায়নি'); else notifyChat(convId);
}
async function sendVoiceMsg(convId, input){
  const f = input.files[0]; if (!f) return;
  toast('ভয়েস আপলোড হচ্ছে...');
  const url = await uploadImage(f);
  if (!url) { toast('আপলোড হয়নি'); return; }
  const { error } = await sb.from('messages').insert({ conversation_id: convId, sender_id: me.id, body: '🎧AUDIO:' + url });
  if (error) toast('যায়নি'); else notifyChat(convId);
}
async function sendMsg(convId){
  const inp = $('#msgInput'); const body = inp.value.trim(); if (!body) return;
  inp.value = '';
  const row = { conversation_id: convId, sender_id: me.id, body };
  if (replyTarget) row.reply_to = replyTarget.id;
  const { error } = await sb.from('messages').insert(row);
  if (error) { toast('মেসেজ যায়নি'); inp.value = body; return; }
  clearReply();
  if (chatMeta && chatMeta.conv && chatMeta.conv.id === convId && chatMeta.myRow && chatMeta.myRow.requested) {
    chatMeta.myRow.requested = false; chatMeta.isReq = false;
    sb.from('conversation_members').update({ requested: false }).eq('conversation_id', convId).eq('user_id', me.id).then(() => {});
    const rb = $('#reqBar'); if (rb) rb.remove();
  }
  notifyChat(convId);
}
async function acceptRequest(convId){
  const { error } = await sb.from('conversation_members').update({ requested: false }).eq('conversation_id', convId).eq('user_id', me.id);
  if (error) { toast('করা যায়নি'); return; }
  if (chatMeta && chatMeta.myRow) { chatMeta.myRow.requested = false; chatMeta.isReq = false; }
  const rb = $('#reqBar'); if (rb) rb.remove();
  if (typeof renderMsgList === 'function') renderMsgList();
  if (!me.hide_reads) { const nowIso = new Date().toISOString(); sb.from('conversation_members').update({ last_read_at: nowIso }).eq('conversation_id', convId).eq('user_id', me.id).then(() => {}); if (chatMeta && chatMeta.myRow) chatMeta.myRow.last_read_at = nowIso; }
  toast('রিকুয়েস্ট গ্রহণ করা হয়েছে ✓');
}
async function deleteRequest(convId){
  const { error } = await sb.from('conversation_members').delete().eq('conversation_id', convId).eq('user_id', me.id);
  if (error) { toast('মোছা যায়নি'); return; }
  toast('রিকুয়েস্ট মোছা হয়েছে');
  renderChatList('requests');
}
async function blockRequest(uid, convId){
  await blockUser(uid);
  await sb.from('conversation_members').delete().eq('conversation_id', convId).eq('user_id', me.id);
  renderChatList('requests');
}
async function notifyChat(convId){
  const { data: members } = await sb.from('conversation_members').select('*').eq('conversation_id', convId);
  (members || []).filter(m => m.user_id !== me.id && !m.muted && !m.restricted && !m.requested).forEach(m => notify(m.user_id, 'message', null, convId));
}

/* ---------- SETTINGS ---------- */
function toggleLocal(key, label){
  const on = localStorage.getItem(key) === '1';
  localStorage.setItem(key, on ? '0' : '1');
  if (key === 'adda-big') document.documentElement.classList.toggle('big', !on);
  toast(label + (!on ? ' চালু হয়েছে' : ' বন্ধ হয়েছে'));
  renderSettings();
}
async function toggleHideReads(){
  const next = !me.hide_reads;
  const { error } = await sb.from('profiles').update({ hide_reads: next }).eq('id', me.id);
  if (error) { toast('বদলানো যায়নি'); return; }
  me.hide_reads = next; profilesCache[me.id] = me;
  toast(next ? 'রিড রিসিপ্ট লুকানো হয়েছে' : 'রিড রিসিপ্ট দেখানো হবে');
  renderSettings();
}
async function renderAdmin(){
  if (!me.is_admin) { go('feed'); return; }
  curView = 'admin'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('shield', 19)} অ্যাডমিন ড্যাশবোর্ড</div><div class="empty">লোড হচ্ছে...</div></div>`;
  const [u, p, r] = await Promise.all([
    sb.from('profiles').select('id', { count: 'exact', head: true }),
    sb.from('posts').select('id', { count: 'exact', head: true }),
    sb.from('reports').select('id', { count: 'exact', head: true })
  ]);
  const { data: reps } = await sb.from('reports').select('*').order('created_at', { ascending: false }).limit(50);
  await cacheProfiles((reps || []).map(x => x.reporter));
  const { data: users } = await sb.from('profiles').select('*').order('created_at', { ascending: false }).limit(30);
  (users || []).forEach(x => { profilesCache[x.id] = x; });
  view().innerHTML = `<div class="view">
    <div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('shield', 19)} অ্যাডমিন ড্যাশবোর্ড</div>
    <div class="stats" style="margin-top:12px"><div><b>${bn(u.count || 0)}</b><small>মোট ব্যবহারকারী</small></div><div><b>${bn(p.count || 0)}</b><small>মোট পোস্ট</small></div><div><b>${bn(r.count || 0)}</b><small>রিপোর্ট</small></div></div>
    <div class="seclabel">রিপোর্টসমূহ</div>
    <div class="card" style="padding:6px 15px">${(reps || []).length ? reps.map(x => { const rp = prof(x.reporter); return `<div style="padding:9px 0;border-bottom:1px solid var(--line2)">
      <div style="font-size:13.5px"><b>${esc(rp.name)}</b> <span style="color:var(--mut)">· ${timeAgo(x.created_at)}</span></div>
      <div style="font-size:13px;color:var(--mut);margin:2px 0 7px">${x.target_type === 'post' ? 'একটি পোস্টে' : 'একজন ব্যবহারকারীর বিরুদ্ধে'} রিপোর্ট${x.reason ? ' — ' + esc(x.reason) : ''}</div>
      <div style="display:flex;gap:7px;flex-wrap:wrap">
        ${x.target_type === 'post' ? `<button class="btn ghost sm" onclick="viewPost('${x.target_id}')">পোস্টটি দেখো</button><button class="btn sm" style="background:var(--danger)" onclick="adminDeletePost('${x.id}','${x.target_id}')">পোস্ট মুছো</button>` : `<button class="btn ghost sm" onclick="goProfile('${x.target_id}')">প্রোফাইল দেখো</button>`}
        <button class="btn ghost sm" onclick="adminDismiss('${x.id}')">রিপোর্ট বাতিল</button>
      </div></div>`; }).join('') : '<div class="empty">কোনো রিপোর্ট নেই</div>'}</div>
    <div class="seclabel">ব্যবহারকারী</div>
    <div class="card" style="padding:6px 15px">${(users || []).map(x => userRow(x, `<span style="display:flex;gap:6px;align-items:center"><span style="display:inline-flex;align-items:center;gap:3px;font-size:12.5px;color:var(--mut)">${ic('wallet', 13)}<b style="color:var(--ink)">${bn(x.tokens || 0)}</b></span><button class="btn ghost sm" onclick="adminTokens('${x.id}')">কয়েন</button><button class="btn ${x.verified ? '' : 'ghost'} sm" onclick="adminToggle('${x.id}','verified',${!!x.verified})">${x.verified ? 'ভেরিফাইড' : 'ভেরিফাই করো'}</button><button class="btn ${x.badge ? '' : 'ghost'} sm" onclick="adminToggle('${x.id}','badge',${!!x.badge})">${x.badge ? 'ব্যাজ সরাও' : 'ব্যাজ দাও'}</button></span>`)).join('')}</div>
  </div>`;
}
async function adminToggle(uid, field, cur){
  const { error } = await sb.from('profiles').update({ [field]: !cur }).eq('id', uid);
  if (error) { toast('করা যায়নি'); return; }
  if (profilesCache[uid]) profilesCache[uid][field] = !cur;
  toast('হয়ে গেছে ✓'); renderAdmin();
}
function adminTokens(uid){
  const u = profilesCache[uid]; if (!u) return;
  sheet(`<h3 style="display:flex;align-items:center;gap:7px">${ic('wallet', 18)} কয়েন ঠিক করো</h3>
    <p style="font-size:13.5px;color:var(--mut)">${esc(u.name)}-এর এখনকার ব্যালান্স: <b style="color:var(--ink)">${bn(u.tokens || 0)} কয়েন</b></p>
    <input class="field" id="admTokAmt" type="number" min="1" placeholder="কত কয়েন? (যেমন: ৫০)">
    <div style="display:flex;gap:8px">
      <button class="btn" style="flex:1" onclick="adminAdjustTokens('${uid}',1)">যোগ করো</button>
      <button class="btn" style="flex:1;background:var(--danger)" onclick="adminAdjustTokens('${uid}',-1)">কমাও</button>
    </div>`);
}
async function adminAdjustTokens(uid, dir){
  const amt = Math.floor(Math.abs(Number(($('#admTokAmt') || {}).value || 0)));
  if (!amt) { toast('আগে পরিমাণ লেখো'); return; }
  const { data: cur, error: e1 } = await sb.from('profiles').select('tokens').eq('id', uid).single();
  if (e1 || !cur) { toast('করা যায়নি'); return; }
  const delta = dir * amt;
  const next = Math.max(0, (cur.tokens || 0) + delta);
  const realDelta = next - (cur.tokens || 0);
  if (realDelta === 0) { toast('ব্যালান্স ০-এর নিচে নামবে না'); return; }
  const { error } = await sb.from('profiles').update({ tokens: next }).eq('id', uid);
  if (error) { toast('করা যায়নি'); return; }
  await sb.from('token_txns').insert({ user_id: uid, amount: realDelta, reason: 'admin' });
  if (profilesCache[uid]) profilesCache[uid].tokens = next;
  if (uid === me.id) me.tokens = next;
  closeSheet(); toast('হয়ে গেছে ✓ নতুন ব্যালান্স: ' + bn(next)); renderAdmin();
}
async function adminDeletePost(repId, postId){
  const { error } = await sb.from('posts').delete().eq('id', postId);
  if (error) { toast('মোছা যায়নি'); return; }
  await sb.from('reports').delete().eq('id', repId);
  toast('পোস্ট মোছা হয়েছে'); renderAdmin();
}
async function adminDismiss(repId){
  await sb.from('reports').delete().eq('id', repId);
  toast('রিপোর্ট বাতিল হয়েছে'); renderAdmin();
}
async function renderSettings(){
  curView = 'settings'; renderShell();
  const { data: fresh } = await sb.from('profiles').select('tokens').eq('id', me.id).single();
  if (fresh) me.tokens = fresh.tokens;
  const tg = (key, icn, label) => `<button class="menu-item" onclick="toggleLocal('${key}','${label}')">${ic(icn)} ${label}<span style="margin-left:auto" class="pill">${localStorage.getItem(key) === '1' ? 'চালু' : 'বন্ধ'}</span></button>`;
  view().innerHTML = `<div class="view">
    <div style="padding:14px 16px 0;font-size:18px;font-weight:800">সেটিংস</div>
    <div class="card" style="display:flex;gap:12px;align-items:center;background:linear-gradient(120deg,rgba(99,102,241,.14),rgba(168,85,247,.14))">
      ${avatar(me, 52, 19)}
      <div style="flex:1;min-width:0"><b style="font-size:16.5px">${esc(me.name)}</b>${badges(me)}<br><small style="color:var(--mut)">${me.username ? '@' + esc(me.username) + ' · ' : ''}${ic('wallet', 13)} <span>${bn(me.tokens)} টোকেন</span> · ${ic('fire', 13)} <span>${bn(me.login_streak || 0)} দিনের স্ট্রিক</span></small></div>
      <button class="btn sm" onclick="renderProfile('${me.id}')">প্রোফাইল</button>
    </div>
    ${me.is_admin ? `<div class="card" style="padding:6px 15px"><button class="menu-item" onclick="go('admin')">${ic('shield', 17)} অ্যাডমিন ড্যাশবোর্ড</button></div>` : ''}
    <div class="seclabel">আমার জিনিস</div>
    <div class="card" style="padding:6px 15px">
      <button class="menu-item" onclick="editProfile()">${ic('edit')} প্রোফাইল এডিট</button>
      <button class="menu-item" onclick="go('tokens')">${ic('wallet')} টোকেন ওয়ালেট <span style="margin-left:auto;font-weight:800;color:var(--acc)">${bn(me.tokens)}</span></button>
      <button class="menu-item" onclick="renderTokens()">${ic('fire')} লগইন স্ট্রিক <span style="margin-left:auto;font-weight:800">${bn(me.login_streak || 0)} দিন</span></button>
      <button class="menu-item" onclick="go('saved')">${ic('bookmark')} সেভ করা পোস্ট</button>
      <button class="menu-item" onclick="go('archived')">${ic('archive')} আর্কাইভ করা পোস্ট</button>
      <button class="menu-item" onclick="renderViewers()">${ic('eye')} প্রোফাইল দর্শক</button>
      <button class="menu-item" onclick="go('albums')">${ic('img')} আমার অ্যালবাম</button>
      <button class="menu-item" onclick="go('closefriends')">${ic('heart')} কাছের বন্ধুরা</button>
      <button class="menu-item" onclick="go('anon')">${ic('eyeOff')} বেনামি প্রশ্নের ইনবক্স</button>
      <button class="menu-item" onclick="downloadMyData()">${ic('download')} আমার ডেটা ডাউনলোড</button>
    </div>
    <div class="seclabel">মজা ও শেখা</div>
    <div class="card" style="padding:6px 15px">
      <button class="menu-item" onclick="go('creator')">${ic('chart')} ক্রিয়েটর ড্যাশবোর্ড</button>
      <button class="menu-item" onclick="go('themes')">${ic('palette')} প্রোফাইল থিম</button>
    </div>
    <div class="seclabel">কমিউনিটি</div>
    <div class="card" style="padding:6px 15px">
      <button class="menu-item" onclick="go('groups')">${ic('users')} গ্রুপ</button>
      <button class="menu-item" onclick="go('pages')">${ic('file')} পেজ</button>
      <button class="menu-item" onclick="go('events')">${ic('calendar')} ইভেন্ট</button>
      <button class="menu-item" onclick="go('market')">${ic('bag')} আড্ডা বাজার</button>
      <button class="menu-item" onclick="go('service')">${ic('hand')} সেবা বোর্ড (রক্ত · হারানো · চাকরি)</button>
      <button class="menu-item" onclick="go('gov')">${ic('landmark')} সরকারি সেবা ও কর্নার</button>
      ${localStorage.getItem('adda-kid') === '1' ? '' : `<button class="menu-item" onclick="go('dating')">${ic('heart')} মনের মানুষ</button>`}
    </div>
    <div class="seclabel">নিরাপত্তা ও প্রাইভেসি</div>
    <div class="card" style="padding:6px 15px">
      <button class="menu-item" onclick="changePasswordSheet()">${ic('key')} পাসওয়ার্ড বদলাও</button>
      <button class="menu-item" onclick="defAudSheet()">${ic('target')} নতুন পোস্ট কে দেখবে (ডিফল্ট) <span style="margin-left:auto" class="pill">${{ public: 'সবাই', friends: 'বন্ধুরা', close: 'কাছের বন্ধুরা', supporters: 'ফলোয়াররা' }[localStorage.getItem('adda-def-aud') || 'public']}</span></button>
      <button class="menu-item" onclick="renderBlocks()">${ic('ban')} ব্লক করা মানুষ</button>
      <button class="menu-item" onclick="toggleHideReads()">${ic('eyeOff')} রিড রিসিপ্ট লুকাও<span style="margin-left:auto" class="pill">${me.hide_reads ? 'চালু' : 'বন্ধ'}</span></button>
      <button class="menu-item" onclick="msgPrivacySheet()">${ic('msg')} কে মেসেজ পাঠাতে পারবে <span style="margin-left:auto" class="pill">${{ everyone: 'সবাই', friends: 'শুধু বন্ধুরা', nobody: 'কেউ না' }[me.msg_privacy || 'everyone']}</span></button>
      <button class="menu-item" onclick="aboutSheet()">${ic('info')} আড্ডাBook সম্পর্কে</button>
      <button class="menu-item" onclick="logoutEverywhere()">${ic('power')} সব ডিভাইস থেকে লগ আউট</button>
    </div>
    <div class="seclabel">সুবিধা ও নিরাপত্তা</div>
    <div class="card" style="padding:6px 15px">
      <button class="menu-item" onclick="toggleTheme();toast('থিম বদলানো হয়েছে')">${ic('moon')} ডার্ক / লাইট থিম</button>
      ${tg('adda-big', 'type', 'সহজ মোড (বড় লেখা)')}
      ${tg('adda-saver', 'wifi', 'ডেটা সেভার মোড (ছবি চাপ দিলে লোড)')}
      ${tg('adda-kid', 'shield', 'কিড মোড (ডেটিং লুকানো)')}
      <button class="menu-item" onclick="toggleLang()">${ic('globe')} ${LANG === 'en' ? 'Language: English' : 'ভাষা: বাংলা'}</button>
      <button class="menu-item" style="color:var(--danger)" onclick="doLogout()">${ic('logout')} লগ আউট</button>
    </div>
    <p style="text-align:center;color:var(--faint);font-size:11.5px;padding:16px 0 4px">আড্ডাBook · LIMON Labs</p></div>`;
}
function changePasswordSheet(){
  sheet(`<h3>${ic('key', 18)} পাসওয়ার্ড বদলাও</h3>
    <input class="field" type="password" id="npPass" placeholder="নতুন পাসওয়ার্ড (কমপক্ষে ৬ অক্ষর)">
    <input class="field" type="password" id="npPass2" placeholder="আবার লেখো">
    <button class="btn block" onclick="doChangePassword()">বদলে ফেলো</button>`);
}
async function doChangePassword(){
  const a = document.getElementById('npPass').value, b = document.getElementById('npPass2').value;
  if (a.length < 6) { toast('পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে'); return; }
  if (a !== b) { toast('দুটো পাসওয়ার্ড মিলছে না'); return; }
  const { error } = await sb.auth.updateUser({ password: a });
  if (error) { toast('বদলানো যায়নি — আবার লগইন করে চেষ্টা করো'); return; }
  closeSheet(); toast('পাসওয়ার্ড বদলানো হয়েছে 🔑');
}
async function logoutEverywhere(){
  await sb.auth.signOut({ scope: 'global' });
  location.reload();
}
function defAudSheet(){
  const cur = localStorage.getItem('adda-def-aud') || 'public';
  const opts = [['public', 'globe', 'সবাই'], ['friends', 'users', 'শুধু বন্ধুরা'], ['close', 'heart', 'কাছের বন্ধুরা'], ['supporters', 'star', 'ফলোয়াররা']];
  sheet(`<h3>${ic('target', 18)} নতুন পোস্ট কে দেখবে?</h3><p style="font-size:13px;color:var(--mut);margin-bottom:10px">পোস্ট করার সময় এই অপশনটা আগেই বেছে থাকবে — চাইলে পোস্টের সময় বদলাতেও পারবে।</p>` +
    opts.map(([v, icn, t]) => `<button class="menu-item" onclick="setDefAud('${v}')">${ic(icn)} ${t}${cur === v ? ' <span style="margin-left:auto">✓</span>' : ''}</button>`).join(''));
}
function setDefAud(v){
  localStorage.setItem('adda-def-aud', v);
  closeSheet(); toast('ডিফল্ট ঠিক হয়েছে ✓'); renderSettings();
}
function msgPrivacySheet(){
  const cur = me.msg_privacy || 'everyone';
  const opts = [['everyone', 'globe', 'সবাই'], ['friends', 'users', 'শুধু বন্ধুরা'], ['nobody', 'ban', 'কেউ না']];
  sheet(`<h3>${ic('msg', 18)} কে মেসেজ পাঠাতে পারবে?</h3><p style="font-size:13px;color:var(--mut);margin-bottom:10px">শুধু নতুন চ্যাট শুরুর ক্ষেত্রে প্রযোজ্য — পুরনো চ্যাট আগের মতোই চলবে।</p>` +
    opts.map(([v, icn, t]) => `<button class="menu-item" onclick="setMsgPrivacy('${v}')">${ic(icn)} ${t}${cur === v ? ' <span style="margin-left:auto">✓</span>' : ''}</button>`).join(''));
}
async function setMsgPrivacy(v){
  const { error } = await sb.from('profiles').update({ msg_privacy: v }).eq('id', me.id);
  if (error) { toast('বদলানো যায়নি'); return; }
  me.msg_privacy = v; profilesCache[me.id] = me;
  closeSheet(); toast('মেসেজ প্রাইভেসি ঠিক হয়েছে ✓'); renderSettings();
}
async function renderBlocks(){
  curView = 'blocks'; renderShell();
  view().innerHTML = `<div class="view"><div style="padding:14px 16px 0;font-size:18px;font-weight:800">${ic('ban', 19)} ব্লক করা মানুষ</div><div class="card" id="blockList" style="padding:6px 15px"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data } = await sb.from('blocks').select('*').eq('blocker', me.id);
  await cacheProfiles((data || []).map(b => b.blocked));
  const el = document.getElementById('blockList');
  if (el) el.innerHTML = (data || []).length ? data.map(b => userRow(prof(b.blocked), `<button class="btn ghost sm" onclick="unblockUser('${b.blocked}')">আনব্লক</button>`)).join('') : '<div class="empty">কাউকে ব্লক করোনি</div>';
}
async function unblockUser(uid){
  await sb.from('blocks').delete().eq('blocker', me.id).eq('blocked', uid);
  blockedIds.delete(uid);
  toast('আনব্লক করা হয়েছে'); renderBlocks();
}
function aboutSheet(){
  sheet(`<h3>${ic('info', 18)} আড্ডাBook সম্পর্কে</h3>
    <p style="font-size:14px;line-height:1.75">আড্ডাBook — বন্ধুদের সাথে প্রতিদিনের আড্ডার নিজের জায়গা। বানিয়েছে <b>LIMON Labs</b>।<br><br>
    🛡 <b>নিরাপত্তা টিপস:</b> পাসওয়ার্ড কারো সাথে শেয়ার করো না। কেনাবেচায় অগ্রিম টাকা পাঠানোর আগে যাচাই করো। সন্দেহজনক পোস্টে রিপোর্ট করো।<br><br>
    📌 সংস্করণ: v2 (২০২৬)</p>`);
}
function toggleLang(){
  localStorage.setItem('adda-lang', LANG === 'en' ? 'bn' : 'en');
  location.reload();
}

/* ---------- TOKENS ---------- */
const REASONS = { welcome: 'স্বাগত বোনাস 🎉', login: 'দৈনিক লগইন বোনাস', post: 'পোস্ট করার পুরস্কার', comment: 'মন্তব্যের পুরস্কার', invite: 'বন্ধু আমন্ত্রণের পুরস্কার', quiz: 'কুইজ পুরস্কার', boost: 'পোস্ট বুস্ট', gift: 'উপহার পাঠিয়েছ', gift_received: 'উপহার পেয়েছ 🎁', badge: 'প্রিমিয়াম ব্যাজ', fund: 'গ্রুপ তহবিলে জমা', theme: 'প্রোফাইল থিম', admin: 'অ্যাডমিন দিয়েছে / ঠিক করেছে' };
async function renderTokens(){
  curView = 'tokens'; renderShell();
  const { data: fresh } = await sb.from('profiles').select('*').eq('id', me.id).single();
  if (fresh) { me = fresh; profilesCache[me.id] = me; }
  view().innerHTML = `<div class="view">
    <div class="wallet"><small>তোমার ব্যালেন্স</small><div class="bal"><span class="coin">অ</span>${bn(me.tokens)} টোকেন</div>
    <small>প্রতিদিন লগইন, পোস্ট আর মন্তব্য করে টোকেন আয় করো</small><br><small>🔥 লগইন স্ট্রিক: ${bn(me.login_streak || 0)} দিন</small></div>
    <div class="seclabel">টোকেন আয় করো</div>
    <div class="card" style="padding:6px 15px">
      <div class="earn"><span class="eic">${ic('calendar', 20)}</span><div><b>প্রতিদিন লগইন</b><small>প্রতিদিন একবার</small></div><span class="plus">+১০</span></div>
      <div class="earn"><span class="eic">${ic('edit', 20)}</span><div><b>পোস্ট করো</b><small>দিনে সর্বোচ্চ ৫টি পোস্টে</small></div><span class="plus">+১৫</span></div>
      <div class="earn"><span class="eic">${ic('comment', 20)}</span><div><b>মন্তব্য করো</b><small>দিনে সর্বোচ্চ ১০টি</small></div><span class="plus">+৩</span></div>
      <div class="earn"><span class="eic">${ic('sparkles', 20)}</span><div><b>স্বাগত বোনাস</b><small>নতুন অ্যাকাউন্টে একবার</small></div><span class="plus">+১০০</span></div>
    </div>
    <div class="seclabel">টোকেন খরচ করো</div>
    <div class="card" style="padding:6px 15px">
      <div class="earn"><span class="eic">${ic('rocket', 20)}</span><div><b>পোস্ট বুস্ট</b><small>নিজের পোস্টের ⋯ মেনু থেকে, ২৪ ঘণ্টা সবার উপরে</small></div><span class="minus">৫০</span></div>
      <div class="earn"><span class="eic">${ic('gift', 20)}</span><div><b>বন্ধুকে উপহার</b><small>বন্ধুর প্রোফাইল থেকে পাঠাও</small></div><span class="minus">১০০</span></div>
      <div class="earn"><span class="eic" style="background:linear-gradient(135deg,#F59E0B,#FBBF24);color:#fff">${CROWN.replace('width="10" height="10"', 'width="15" height="15"')}</span><div><b>প্রিমিয়াম ব্যাজ</b><small>নামের পাশে সোনালি ব্যাজ ${me.badge ? '— তোমার আছে ✓' : ''}</small></div>${me.badge ? '' : `<button class="btn sm" onclick="buyBadge()">২০০ দিয়ে কেনো</button>`}</div>
    </div>
    <div class="seclabel">ইতিহাস</div>
    <div class="card" id="txnList" style="padding:6px 15px"><div class="empty">লোড হচ্ছে...</div></div></div>`;
  const { data: txns } = await sb.from('token_txns').select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(30);
  $('#txnList').innerHTML = (txns || []).length ? txns.map(t => `<div class="earn"><div><b style="font-size:13.5px">${REASONS[t.reason] || esc(t.reason)}</b><small>${timeAgo(t.created_at)}</small></div><span class="${t.amount >= 0 ? 'plus' : 'minus'}">${t.amount >= 0 ? '+' : ''}${bn(t.amount)}</span></div>`).join('') : '<div class="empty">এখনো কোনো লেনদেন নেই</div>';
}
async function buyBadge(){
  const { error } = await sb.rpc('rpc_spend', { p_item: 'badge', p_target: null });
  if (error) { toast('টোকেন যথেষ্ট নেই (লাগবে ২০০)'); return; }
  me.badge = true; me.tokens -= 200; toast('অভিনন্দন! প্রিমিয়াম ব্যাজ পেয়ে গেছ 👑'); renderTokens();
}

/* ---------- DATING : মনের মানুষ ---------- */
const INTERESTS = ['গান','সিনেমা','ক্রিকেট','বই পড়া','ভ্রমণ','রান্না','ফটোগ্রাফি','কবিতা','খেলাধুলা','প্রযুক্তি'];
let deck = [], deckIdx = 0;
async function renderDating(){
  if (localStorage.getItem('adda-kid') === '1') { toast('কিড মোডে এই অংশ বন্ধ আছে'); go('feed'); return; }
  curView = 'dating'; renderShell();
  const { data: dp } = await sb.from('dating_profiles').select('*').eq('user_id', me.id).maybeSingle();
  if (!dp || !dp.active) {
    view().innerHTML = `<div class="view">
      <div class="card" style="text-align:center;padding:24px 18px">
        <div style="color:#DB2777">${ic('heartF', 44)}</div>
        <div style="font-size:19px;font-weight:800;margin:6px 0">মনের মানুষ</div>
        <p style="color:var(--mut);font-size:13.5px;line-height:1.7">আলাদা একটা জায়গা, যেখানে মনের মিল খুঁজে পাবে।<br>শুধু ১৮+ দের জন্য · সম্পূর্ণ ঐচ্ছিক · ম্যাচ হলেই চ্যাট</p>
      </div>
      <div class="card"><h3 style="margin-bottom:12px;font-size:15.5px">তোমার ডেটিং প্রোফাইল</h3>
        <input class="field" id="dAge" type="number" min="18" max="80" placeholder="বয়স (১৮ বা তার বেশি)">
        <select class="field" id="dGender"><option value="">তুমি —</option><option>ছেলে</option><option>মেয়ে</option><option>অন্যান্য</option></select>
        <select class="field" id="dLooking"><option value="">খুঁজছ —</option><option>ছেলে</option><option>মেয়ে</option><option>সবাইকে</option></select>
        <div style="font-size:13px;color:var(--mut);margin:2px 0 8px">পছন্দ বেছে নাও (ম্যাচ % এগুলো দিয়েই হিসাব হয়):</div>
        <div class="chiprow2" style="padding:0 0 10px">${INTERESTS.map(i => `<label class="ichip" style="cursor:pointer"><input type="checkbox" class="dInt" value="${i}" style="accent-color:#DB2777"> ${i}</label>`).join('')}</div>
        <textarea class="field" id="dBio" placeholder="নিজের সম্পর্কে দু-এক লাইন"></textarea>
        <button class="btn block" onclick="saveDatingProfile()">প্রোফাইল চালু করো</button>
      </div>
      <div class="safe" style="margin-top:12px">🛡 নিরাপত্তা: কেউ বিরক্ত করলে সাথে সাথে ব্লক/রিপোর্ট করো। কারো সাথে দেখা করতে গেলে পাবলিক জায়গা বেছে নাও, বন্ধুকে জানিয়ে যাও। ব্যক্তিগত তথ্য (ঠিকানা, পাসওয়ার্ড) কাউকে দিও না।</div></div>`;
    return;
  }
  window._myDating = dp;
  view().innerHTML = `<div class="view">
    <div style="padding:14px 16px 0;display:flex;align-items:center"><span style="font-size:18px;font-weight:800">${ic('heartF', 18)} মনের মানুষ</span>
    <button class="btn ghost sm" style="margin-left:auto" onclick="datingSettings()">আমার প্রোফাইল</button></div>
    <div id="deckBox"><div class="empty">লোড হচ্ছে...</div></div>
    <div class="seclabel">তোমার ম্যাচ</div><div class="card" id="matchList" style="padding:6px 15px"><div class="empty">লোড হচ্ছে...</div></div>
    <div class="safe" style="margin-top:12px">🛡 ম্যাচ ছাড়া কেউ তোমাকে মেসেজ পাঠাতে পারবে না। বিরক্তিকর কাউকে ব্লক করো — সে আর তোমাকে দেখতে পাবে না।</div></div>`;
  const [{ data: all }, { data: myLikes }] = await Promise.all([
    sb.from('dating_profiles').select('*').eq('active', true).neq('user_id', me.id).limit(60),
    sb.from('dating_likes').select('liked').eq('liker', me.id)
  ]);
  const likedSet = new Set((myLikes || []).map(r => r.liked));
  const passed = new Set(JSON.parse(localStorage.getItem('adda-passed') || '[]'));
  let cands = (all || []).filter(d => !likedSet.has(d.user_id) && !passed.has(d.user_id) && !blockedIds.has(d.user_id));
  if (dp.looking_for && dp.looking_for !== 'সবাইকে') cands = cands.filter(d => d.gender === dp.looking_for);
  await cacheProfiles(cands.map(d => d.user_id));
  deck = cands.map(d => {
    const shared = (d.interests || []).filter(i => (dp.interests || []).includes(i)).length;
    const base = Math.max((d.interests || []).length, (dp.interests || []).length, 1);
    return { d, match: Math.min(98, 55 + Math.round(shared / base * 45)) };
  }).sort((a, b) => b.match - a.match);
  deckIdx = 0; showCard();
  const { data: likesOnMe } = await sb.from('dating_likes').select('liker').eq('liked', me.id);
  const onMe = new Set((likesOnMe || []).map(r => r.liker));
  const matches = [...likedSet].filter(id => onMe.has(id));
  await cacheProfiles(matches);
  $('#matchList').innerHTML = matches.length ? matches.map(id => { const p = prof(id); return userRow(p, `<button class="btn sm" onclick="startChat('${id}')">মেসেজ ${ic('heartF', 13)}</button>`); }).join('') : '<div class="empty">এখনো ম্যাচ হয়নি — পছন্দের প্রোফাইলে ❤ দাও</div>';
}
function showCard(){
  const box = $('#deckBox'); if (!box) return;
  if (deckIdx >= deck.length) { box.innerHTML = '<div class="card empty">আপাতত আর কেউ নেই।<br>পরে আবার দেখো — নতুন মানুষ যোগ দিলে এখানে আসবে।</div>'; return; }
  const { d, match } = deck[deckIdx]; const p = prof(d.user_id);
  const photo = safeUrl(d.photo_url || p.avatar_url);
  box.innerHTML = `<div class="dcard">
    <div class="dphoto" ${photo ? `style="background-image:url('${esc(photo)}')"` : ''}>
      ${photo ? '' : `<span class="face">${esc(p.name[0] || '?')}</span>`}
      <span class="matchp">${bn(match)}% ম্যাচ</span>
      <div class="dinfo"><b>${esc(p.name)}, ${bn(d.age)}</b>${badges(p)}<div style="font-size:12.5px;opacity:.92">${p.city ? '📍 ' + esc(p.city) + ' · ' : ''}এলাকার কাছাকাছি</div></div>
    </div>
    <div class="chiprow2">${(d.interests || []).map(i => `<span class="ichip">${esc(i)}</span>`).join('')}</div>
    ${d.bio ? `<p class="dbio">${esc(d.bio)}</p>` : ''}
    <div class="dacts">
      <button class="dbtn" onclick="passCard()" aria-label="পাস">${ic('x', 24)}</button>
      <button class="dbtn super" onclick="likeCard(true)" aria-label="সুপার লাইক">${ic('starF', 22)}</button>
      <button class="dbtn like" onclick="likeCard(false)" aria-label="লাইক">${ic('heartF', 26)}</button>
    </div>
    <div style="text-align:center;padding-bottom:12px"><a href="#" onclick="datingCardMenu('${d.user_id}');return false" style="font-size:12.5px;color:var(--faint)">রিপোর্ট / ব্লক</a></div></div>`;
}
function passCard(){
  const { d } = deck[deckIdx];
  const passed = JSON.parse(localStorage.getItem('adda-passed') || '[]'); passed.push(d.user_id);
  localStorage.setItem('adda-passed', JSON.stringify(passed));
  deckIdx++; showCard();
}
async function likeCard(isSuper){
  const { d } = deck[deckIdx];
  await sb.from('dating_likes').insert({ liker: me.id, liked: d.user_id, is_super: isSuper });
  const { data: back } = await sb.from('dating_likes').select('liker').eq('liker', d.user_id).eq('liked', me.id).maybeSingle();
  if (back) { notify(d.user_id, 'match'); toast('ম্যাচ হয়েছে! 💘 এখন চ্যাট করতে পারো'); }
  else toast(isSuper ? 'সুপার লাইক পাঠানো হয়েছে ★' : 'লাইক পাঠানো হয়েছে ❤');
  deckIdx++; showCard();
  setTimeout(() => { const ml = $('#matchList'); if (ml) renderDating(); }, 400);
}
function datingCardMenu(uid){
  sheet(`<h3>নিরাপত্তা</h3>
    <button class="menu-item" onclick="reportItem('dating','${uid}')">${ic('flag')} এই প্রোফাইল রিপোর্ট করো</button>
    <button class="menu-item" style="color:var(--danger)" onclick="blockUser('${uid}')">${ic('ban')} ব্লক করো</button>
    <button class="menu-item" onclick="closeSheet()">বন্ধ করো</button>`);
}
async function saveDatingProfile(){
  const age = parseInt($('#dAge').value, 10);
  if (!age || age < 18) { toast('ডেটিং শুধু ১৮ বছর বা তার বেশি বয়সীদের জন্য'); return; }
  const interests = [...document.querySelectorAll('.dInt:checked')].map(c => c.value);
  const { error } = await sb.from('dating_profiles').upsert({ user_id: me.id, age, gender: $('#dGender').value, looking_for: $('#dLooking').value, interests, bio: $('#dBio').value.trim(), photo_url: me.avatar_url || '', active: true });
  if (error) { toast('প্রোফাইল তৈরি হয়নি'); return; }
  toast('ডেটিং প্রোফাইল চালু হয়েছে 💘'); renderDating();
}
function datingSettings(){
  const dp = window._myDating;
  sheet(`<h3>আমার ডেটিং প্রোফাইল</h3>
    <p style="font-size:13.5px;color:var(--mut);line-height:1.7">বয়স: ${bn(dp.age)} · ${esc(dp.gender || '')} · খুঁজছ: ${esc(dp.looking_for || '')}<br>পছন্দ: ${(dp.interests || []).join(', ') || '—'}<br>${esc(dp.bio || '')}</p>
    <button class="btn block" style="margin-top:12px;background:var(--danger);box-shadow:none" onclick="deactivateDating()">ডেটিং বন্ধ করো</button>
    <button class="menu-item" onclick="closeSheet()">বন্ধ করো</button>`);
}
async function deactivateDating(){
  await sb.from('dating_profiles').update({ active: false }).eq('user_id', me.id);
  closeSheet(); toast('ডেটিং প্রোফাইল বন্ধ করা হয়েছে'); renderDating();
}
