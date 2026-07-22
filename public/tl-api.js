/* ============================================
   타이라이프 · Supabase 데이터 레이어
   localStorage를 대체합니다.
   ============================================ */
const SUPABASE_URL = window.TL_CONFIG?.url || '';
const SUPABASE_KEY = window.TL_CONFIG?.anonKey || '';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

const TL = {
  _me: null,        // { id, nick, name, phone, level, blocked }
  _isAdmin: false,

  /* ---------- 인증 ---------- */
  async init() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await this._loadMe(session.user.id);
    sb.auth.onAuthStateChange(async (_e, s) => {
      if (s) await this._loadMe(s.user.id); else { this._me = null; this._isAdmin = false; }
      window.dispatchEvent(new CustomEvent('tl:auth'));
    });
    return this._me;
  },

  async _loadMe(uid) {
    const { data } = await sb.from('profiles').select('*').eq('id', uid).single();
    this._me = data || null;
    if (data) {
      const { data: a } = await sb.from('admins').select('user_id').eq('user_id', uid).maybeSingle();
      this._isAdmin = !!a;
      await sb.from('profiles').update({
        last_seen: new Date().toISOString(),
        logins: (data.logins || 0) + 1
      }).eq('id', uid);
    }
  },

  me() { return this._me; },
  nick() { return this._me?.nick || null; },
  isAdmin() { return this._isAdmin; },

  async signUp({ nick, name, phone, email, password }) {
    // 닉네임 중복 확인
    const { data: dup } = await sb.from('profiles').select('nick').eq('nick', nick).maybeSingle();
    if (dup) throw new Error('이미 사용 중인 닉네임입니다.');
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { nick, name, phone } }
    });
    if (error) throw new Error(this._authMsg(error.message));
    // 세션이 없으면(이메일 확인 설정이 켜진 경우) 즉시 로그인 시도
    if (!data.session) {
      const { error: e2 } = await sb.auth.signInWithPassword({ email, password });
      if (e2) throw new Error('가입은 완료됐지만 자동 로그인에 실패했습니다. Supabase에서 Confirm email을 꺼주세요.');
    }
    const { data: { session } } = await sb.auth.getSession();
    if (session) await this._loadMe(session.user.id);
    return data;
  },

  async signIn(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다.');
    return data;
  },

  async signOut() { await sb.auth.signOut(); this._me = null; this._isAdmin = false; },

  async changePassword(newPw) {
    const { error } = await sb.auth.updateUser({ password: newPw });
    if (error) throw new Error(error.message);
  },

  _authMsg(m) {
    if (/already registered/i.test(m)) return '이미 가입된 이메일입니다.';
    if (/password/i.test(m)) return '비밀번호는 6자 이상이어야 합니다.';
    if (/email/i.test(m)) return '올바른 이메일 주소를 입력해주세요.';
    return m;
  },

  /* ---------- 회원 ---------- */
  async members() {
    const { data } = await sb.from('profiles').select('*').order('created_at', { ascending: false });
    return data || [];
  },
  async setLevel(nick, level) {
    await sb.from('profiles').update({ level }).eq('nick', nick);
  },
  async setBlocked(nick, blocked) {
    await sb.from('profiles').update({ blocked }).eq('nick', nick);
  },

  /* ---------- 채팅 ---------- */
  async chatList(limit = 100) {
    const { data } = await sb.from('chats').select('*').order('created_at', { ascending: true }).limit(limit);
    const ids = (data || []).map(c => c.id);
    let reps = [];
    if (ids.length) {
      const { data: r } = await sb.from('chat_replies').select('*').in('chat_id', ids).order('created_at');
      reps = r || [];
    }
    return (data || []).map(c => ({ ...c, replies: reps.filter(r => r.chat_id === c.id) }));
  },
  async chatSend(text, { notice = false, isAdmin = false } = {}) {
    const me = this._me; if (!me) throw new Error('로그인이 필요합니다.');
    const { error } = await sb.from('chats').insert({
      user_id: me.id, nick: notice || isAdmin ? '관리자' : me.nick,
      text, notice, is_admin: isAdmin
    });
    if (error) throw new Error(error.message);
    if (!notice && !isAdmin) await sb.rpc('noop').catch(() => {});
  },
  async replySend(chatId, text) {
    const me = this._me; if (!me) throw new Error('로그인이 필요합니다.');
    const { error } = await sb.from('chat_replies').insert({
      chat_id: chatId, user_id: me.id, nick: me.nick, text, is_admin: this._isAdmin
    });
    if (error) throw new Error(error.message);
  },
  async chatDelete(id) { await sb.from('chats').delete().eq('id', id); },
  async replyDelete(id) { await sb.from('chat_replies').delete().eq('id', id); },
  async chatDeleteByNick(nick) { await sb.from('chats').delete().eq('nick', nick); },
  onChat(cb) {
    return sb.channel('chat-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chats' }, cb)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_replies' }, cb)
      .subscribe();
  },

  /* ---------- 게시판 ---------- */
  async posts(board) {
    const { data } = await sb.from('posts').select('*').eq('board', board).order('created_at', { ascending: false });
    return data || [];
  },
  async postAdd(board, obj) {
    const me = this._me; if (!me) throw new Error('로그인이 필요합니다.');
    const { error } = await sb.from('posts').insert({
      board, user_id: me.id,
      author: (board === 'news' || this._isAdmin) && obj._asAdmin ? '관리자' : me.nick,
      ...obj, _asAdmin: undefined
    });
    if (error) throw new Error(error.message);
    await sb.from('profiles').update({ posts: (me.posts || 0) + 1 }).eq('id', me.id);
  },
  async postUpdate(id, patch) {
    const { error } = await sb.from('posts').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
  },
  async postDelete(id) { await sb.from('posts').delete().eq('id', id); },
  async joinMeet(id, nick) {
    const { data } = await sb.from('posts').select('joiners').eq('id', id).single();
    const j = data?.joiners || [];
    const next = j.includes(nick) ? j.filter(x => x !== nick) : [...j, nick];
    await sb.from('posts').update({ joiners: next }).eq('id', id);
    return next;
  },

  /* ---------- 알림 ---------- */
  async notifs() {
    const { data } = await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(50);
    return data || [];
  },
  async notifSend(target, icon, title, body) {
    const { error } = await sb.from('notifications').insert({ target, icon, title, body });
    if (error) throw new Error(error.message);
  },
  async unreadCount() {
    if (!this._me) return 0;
    const { data: r } = await sb.from('notif_reads').select('last_read').eq('user_id', this._me.id).maybeSingle();
    const last = r?.last_read || '1970-01-01';
    const { count } = await sb.from('notifications')
      .select('*', { count: 'exact', head: true })
      .gt('created_at', last)
      .or(`target.eq.@all,target.eq.${this._me.nick}`);
    return count || 0;
  },
  async markRead() {
    if (!this._me) return;
    await sb.from('notif_reads').upsert({ user_id: this._me.id, last_read: new Date().toISOString() });
  },
  onNotif(cb) {
    return sb.channel('notif-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, cb)
      .subscribe();
  },

  /* ---------- 쿠폰 ---------- */
  async myCoupons() {
    if (!this._me) return [];
    const { data } = await sb.from('coupons').select('*').eq('nick', this._me.nick).order('created_at', { ascending: false });
    return data || [];
  },
  async couponSend(nick, { title, partner, descr, code }) {
    const { error } = await sb.from('coupons').insert({ nick, title, partner, descr, code });
    if (error) throw new Error(error.message);
    await this.notifSend(nick, '🎟', '쿠폰 선물이 도착했어요!',
      `"${title}"${partner ? ' — ' + partner : ''}\n프로필 → 내 쿠폰함에서 확인하세요!`);
  },

  /* ---------- 설정 ---------- */
  async getSetting(key, def = null) {
    const { data } = await sb.from('settings').select('value').eq('key', key).maybeSingle();
    return data?.value ?? def;
  },
  async setSetting(key, value) {
    const { error } = await sb.from('settings').upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  },

  /* ---------- 이미지 업로드 ---------- */
  async uploadImage(file, folder = 'gallery') {
    const me = this._me; if (!me) throw new Error('로그인이 필요합니다.');
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${folder}/${me.id}/${Date.now()}.${ext}`;
    const { error } = await sb.storage.from('images').upload(path, file, { upsert: false });
    if (error) throw new Error('이미지 업로드 실패: ' + error.message);
    const { data } = sb.storage.from('images').getPublicUrl(path);
    return data.publicUrl;
  }
};

window.TL = TL;
window.sb = sb;
