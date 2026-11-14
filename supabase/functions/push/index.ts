// 송지희 국어 – 무료 푸시 알림 서버
// action=key   : 알림용 공개키 (처음 호출 때 키를 만들어 DB에 보관)
// action=send  : 선생님이 고른 학생(+학부모)에게 알림 보내기
// action=test  : 선생님 본인에게 테스트 알림
// action=auto  : 매일 자동 알림 (새 어휘 테스트 / 마감 24시간 전 미제출) – 예약 작업만 호출 가능
// action=opened: 5분마다 – 방금 공개된 테스트만 바로 알림 (예약 작업만 호출 가능)
// action=staff_notify: 학생이 블랙리스트 해결·질문을 올리면 선생님·조교에게 알림 (학생 본인 확인)
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const pick = (jsonEnv: string, legacy: string) => {
  try { const v = JSON.parse(Deno.env.get(jsonEnv) || '{}')['default']; if (v) return v; } catch (_) { /* ignore */ }
  return Deno.env.get(legacy)!;
};
const SECRET_KEY = pick('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const PUBLISHABLE_KEY = pick('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const admin = createClient(SB_URL, SECRET_KEY, { auth: { persistSession: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

async function getSecret(k: string): Promise<string | null> {
  const { data } = await admin.from('app_secrets').select('value').eq('key', k).maybeSingle();
  return data?.value ?? null;
}
async function vapid(): Promise<string> {
  let pub = await getSecret('vapid_public'), priv = await getSecret('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    const { error } = await admin.from('app_secrets').insert([{ key: 'vapid_public', value: k.publicKey }, { key: 'vapid_private', value: k.privateKey }]);
    if (error) { pub = await getSecret('vapid_public'); priv = await getSecret('vapid_private'); } // 동시에 만들어졌으면 먼저 저장된 키 사용
    else { pub = k.publicKey; priv = k.privateKey; }
  }
  webpush.setVapidDetails('https://readingtext.netlify.app', pub!, priv!);
  return pub!;
}

type Payload = { title: string; body: string; url?: string; tag?: string };
async function sendTo(userIds: string[], payload: Payload) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return { users: 0, devices: 0, failed: 0, reached: [] as string[] };
  const subs: any[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin.from('push_subscriptions').select('*').in('user_id', ids.slice(i, i + 200));
    subs.push(...(data || []));
  }
  let devices = 0, failed = 0; const reached = new Set<string>();
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 24, urgency: 'normal' });
      devices++; reached.add(s.user_id);
    } catch (e: any) {
      failed++;
      if (e?.statusCode === 404 || e?.statusCode === 410) await admin.from('push_subscriptions').delete().eq('id', s.id);
    }
  }));
  return { users: reached.size, devices, failed, reached: [...reached] };
}

async function parentsOf(studentIds: string[]) {
  if (!studentIds.length) return [] as { parent_id: string; student_id: string }[];
  const { data } = await admin.from('parent_links').select('parent_id, student_id, profiles!parent_links_parent_id_fkey(status)').in('student_id', studentIds);
  return (data || []).filter((r: any) => r.profiles?.status === 'approved').map((r: any) => ({ parent_id: r.parent_id, student_id: r.student_id }));
}

async function notLogged(kind: string, ref: string, userIds: string[]) {
  if (!userIds.length) return [];
  const { data } = await admin.from('push_log').select('user_id').eq('kind', kind).eq('ref_id', ref);
  const done = new Set((data || []).map((r: any) => r.user_id));
  return userIds.filter((u) => !done.has(u));
}
async function log(kind: string, ref: string, userIds: string[]) {
  if (userIds.length) await admin.from('push_log').upsert(userIds.map((u) => ({ kind, ref_id: ref, user_id: u })), { onConflict: 'kind,ref_id,user_id', ignoreDuplicates: true });
}
const kst = (d: string) => new Date(d).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });

async function auto(onlyNew = false) {
  const now = new Date(), nowIso = now.toISOString();
  const in24 = new Date(now.getTime() + 24 * 3600e3).toISOString(), ago24 = new Date(now.getTime() - 24 * 3600e3).toISOString();
  const { data: studs } = await admin.from('profiles').select('id, full_name, class_id').eq('role', 'student').eq('status', 'approved');
  const target = (item: { class_id: string | null }) => (studs || []).filter((s: any) => !item.class_id || item.class_id === s.class_id);
  const out = { new_vocab: 0, due_vocab: 0, due_assignment: 0, parents: 0 };

  const remindParents = async (kind: string, ref: string, missing: any[], body: (s: any) => string, url: (s: any) => string) => {
    const links = await parentsOf(missing.map((s) => s.id));
    for (const l of links) {
      // 자녀가 여러 명이면 자녀마다 한 번씩 보내도록 kind에 학생 id를 붙여서 기록
      const k2 = `${kind}:${l.student_id}`;
      const ok = await notLogged(k2, ref, [l.parent_id]);
      if (!ok.length) continue;
      const s = missing.find((x) => x.id === l.student_id);
      await sendTo([l.parent_id], { title: '⏰ 미제출 알림', body: body(s), url: url(s), tag: k2 + ref });
      await log(k2, ref, [l.parent_id]); out.parents++;
    }
  };

  // 1) 지난 24시간 안에 공개된 어휘 테스트 → 학생에게 안내
  const { data: nv } = await admin.from('vocab_tests').select('*').lte('open_at', nowIso).gte('open_at', ago24);
  for (const t of nv || []) {
    const ids = await notLogged('vocab_new', t.id, target(t).map((s: any) => s.id));
    if (!ids.length) continue;
    const how = t.grading === 'self' ? '시험지를 풀고 결과를 적어 주세요.' : '시험지를 확인해 주세요.';
    await sendTo(ids, { title: `📚 새 ${t.category || '테스트'}`, body: `'${t.title}'가 올라왔어요. ${how}`, url: `./#/vocab/${t.id}`, tag: 'vocab_new' + t.id });
    await log('vocab_new', t.id, ids); out.new_vocab += ids.length;
  }
  if (onlyNew) return out;

  // 2) 24시간 안에 마감인 어휘 테스트 미제출 → 학생 + 학부모
  const { data: dv } = await admin.from('vocab_tests').select('*').eq('grading', 'self').lte('open_at', nowIso).gt('due_at', nowIso).lte('due_at', in24);
  for (const t of dv || []) {
    const { data: rs } = await admin.from('vocab_results').select('user_id').eq('test_id', t.id);
    const done = new Set((rs || []).map((r: any) => r.user_id));
    const missing = target(t).filter((s: any) => !done.has(s.id));
    const ids = await notLogged('vocab_due', t.id, missing.map((s: any) => s.id));
    if (ids.length) {
      await sendTo(ids, { title: `⏰ ${t.category || '테스트'} 마감 임박`, body: `'${t.title}' 마감이 ${kst(t.due_at)}이에요. 아직 결과를 안 적었어요.`, url: `./#/vocab/${t.id}`, tag: 'vocab_due' + t.id });
      await log('vocab_due', t.id, ids); out.due_vocab += ids.length;
    }
    await remindParents('vocab_due_p', t.id, missing, (s) => `${s.full_name} 학생이 '${t.title}'를 아직 내지 않았어요. (마감 ${kst(t.due_at)})`, (s) => `./#/child/${s.id}`);
  }

  // 3) 24시간 안에 마감인 숙제 미제출 → 학생 + 학부모
  const { data: da } = await admin.from('assignments').select('*').gt('due_at', nowIso).lte('due_at', in24);
  const { data: ro } = await admin.from('roster').select('profile_id, mode').not('profile_id', 'is', null);
  const modeOf = new Map((ro || []).map((r: any) => [r.profile_id, r.mode]));
  for (const a of da || []) {
    const { data: ss } = await admin.from('submissions').select('user_id').eq('assignment_id', a.id);
    const done = new Set((ss || []).map((r: any) => r.user_id));
    const missing = target(a).filter((s: any) => !done.has(s.id) && (!a.only_online || modeOf.get(s.id) === '인강'));
    const ids = await notLogged('asg_due', a.id, missing.map((s: any) => s.id));
    if (ids.length) {
      await sendTo(ids, { title: '📝 숙제 마감 임박', body: `'${a.title}' 마감이 ${kst(a.due_at)}이에요. 아직 안 냈어요.`, url: `./#/assignment/${a.id}`, tag: 'asg_due' + a.id });
      await log('asg_due', a.id, ids); out.due_assignment += ids.length;
    }
    await remindParents('asg_due_p', a.id, missing, (s) => `${s.full_name} 학생이 숙제 '${a.title}'를 아직 내지 않았어요. (마감 ${kst(a.due_at)})`, (s) => `./#/child/${s.id}`);
  }
  // 4) 결석 보충 영상: 수업일 + 3일이 지나도록 90% 미만이면 학생·학부모에게 한 번
  const kstToday = new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
  const d3 = new Date(Date.parse(kstToday) - 3 * 86400e3).toISOString().slice(0, 10);
  const d14 = new Date(Date.parse(kstToday) - 14 * 86400e3).toISOString().slice(0, 10);
  const { data: vdays } = await admin.from('class_days').select('id, day, video_id, class_id').not('video_id', 'is', null).lte('day', d3).gte('day', d14);
  (out as any).absent_video = 0;
  for (const d of vdays || []) {
    const { data: recs } = await admin.from('class_records').select('roster_id, hw1, hw2, t1_flag, t2_flag, roster:roster_id(name, profile_id, status)').eq('day_id', d.id);
    const absent = (recs || []).filter((r: any) => [r.hw1, r.hw2, r.t1_flag, r.t2_flag].includes('결석') && r.roster?.profile_id && r.roster?.status === '재원');
    if (!absent.length) continue;
    const { data: v } = await admin.from('videos').select('title').eq('id', d.video_id).maybeSingle();
    const { data: prog } = await admin.from('video_progress').select('user_id, percent, completed').eq('video_id', d.video_id).in('user_id', absent.map((r: any) => r.roster.profile_id));
    const pm = new Map((prog || []).map((p: any) => [p.user_id, p]));
    const md = `${+d.day.slice(5, 7)}/${+d.day.slice(8, 10)}`;
    for (const r of absent) {
      const sid = r.roster.profile_id, p: any = pm.get(sid);
      if (p?.completed || (p?.percent ?? 0) >= 90) continue;
      const ok = await notLogged('absent_video', d.id, [sid]);
      if (!ok.length) continue;
      const pct = p?.percent ?? 0;
      await sendTo([sid], { title: '📺 결석 보충 영상', body: `${md} 수업 영상 '${v?.title || ''}'을 아직 다 보지 않았어요. (현재 ${pct}%)`, url: `./#/video/${d.video_id}`, tag: 'absent_video' + d.id });
      const links = await parentsOf([sid]);
      if (links.length) await sendTo(links.map((l) => l.parent_id), { title: `📺 ${r.roster.name} 학생 결석 보충 영상`, body: `${md} 수업 영상을 아직 다 보지 않았어요. (현재 ${pct}%)`, url: `./#/child/${sid}`, tag: 'absent_video_p' + d.id });
      await log('absent_video', d.id, [sid]); (out as any).absent_video++;
    }
  }
  return out;
}

async function staffIds() {
  const { data } = await admin.from('profiles').select('id').in('role', ['teacher', 'assistant']).eq('status', 'approved');
  return (data || []).map((x: any) => x.id);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const action = body.action || new URL(req.url).searchParams.get('action');

    if (action === 'key') return json({ publicKey: await vapid() });

    if (action === 'auto' || action === 'opened') {
      const given = req.headers.get('x-cron-secret');
      if (!given || given !== (await getSecret('cron_secret'))) return json({ error: 'forbidden' }, 403);
      await vapid();
      return json(await auto(action === 'opened'));
    }

    const authHeader = req.headers.get('Authorization') || '';
    const userClient = createClient(SB_URL, PUBLISHABLE_KEY, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });

    // 학생 → 선생님·조교 알림 (본인이 방금 올린 것만)
    if (action === 'staff_notify') {
      const { data: u } = await userClient.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
      if (!u?.user) return json({ error: 'login required' }, 401);
      const { data: me } = await admin.from('profiles').select('full_name').eq('id', u.user.id).maybeSingle();
      const since = new Date(Date.now() - 10 * 60e3).toISOString();
      let payload: Payload | null = null, ref = '';
      if (body.kind === 'bl') {
        const { data: x } = await admin.from('bl_submissions').select('id, roster:roster_id(class_id)').eq('id', body.id).eq('user_id', u.user.id).gte('created_at', since).maybeSingle();
        if (x) { ref = x.id; payload = { title: '📌 블랙리스트 해결 제출', body: `${me?.full_name || '학생'}이(가) 해결 사진을 올렸어요. 확인해 주세요.`, url: `./#/t/records/${(x as any).roster?.class_id}/black` }; }
      } else if (body.kind === 'q') {
        const { data: x } = await admin.from('questions').select('id, status').eq('id', body.id).eq('user_id', u.user.id).maybeSingle();
        if (x) { ref = x.id; payload = { title: x.status === 'confused' ? '🤔 아직 어려워요' : '❓ 새 질문', body: `${me?.full_name || '학생'}: ${String(body.preview || '').slice(0, 80)}`, url: `./#/t/qna/${x.id}` }; }
      }
      if (!payload) return json({ error: 'not found' }, 404);
      await vapid();
      return json(await sendTo(await staffIds(), { ...payload, tag: 'staff' + ref }));
    }

    // 여기부터는 로그인한 선생님만
    const { data: isTeacher } = await userClient.rpc('is_teacher');
    if (!isTeacher) return json({ error: '선생님만 알림을 보낼 수 있어요' }, 403);
    await vapid();

    if (action === 'test') {
      const { data: u } = await userClient.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
      if (!u?.user) return json({ error: 'login required' }, 401);
      return json(await sendTo([u.user.id], { title: '🔔 테스트 알림', body: '알림이 잘 와요! 송지희 국어', url: './' }));
    }
    if (action === 'send') {
      const ids: string[] = (Array.isArray(body.user_ids) ? body.user_ids : []).slice(0, 3000);
      const payload: Payload = { title: String(body.title || '송지희 국어').slice(0, 80), body: String(body.body || '').slice(0, 400), url: String(body.url || './').slice(0, 200) };
      const students = await sendTo(ids, payload);
      let parents = { users: 0, devices: 0, failed: 0 };
      if (body.include_parents) {
        const links = await parentsOf(ids);
        parents = await sendTo(links.map((l) => l.parent_id), { ...payload, title: payload.title, url: './' });
      }
      return json({ students: { users: students.users, devices: students.devices }, parents: { users: parents.users, devices: parents.devices }, reached: students.reached, requested: ids.length });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
