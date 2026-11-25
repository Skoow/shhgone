// Poste de pilotage. Le jeton reste dans une variable de cet onglet (ni stockage local ni
// cookie) ; la page n'écrit que du texte (textContent), jamais de HTML.
'use strict';

let jeton = '';
let minuterie = 0;
let echecs = 0; // lectures d'état sans réponse, de suite
let gele = false;
let armeGel = 0;
let armeDetruire = 0;
let suspendues = false; // ventes des offres suspendues (lu dans /api/paiement)
let armeVentes = 0;

const $ = (id) => document.getElementById(id);

function el(nom, texte, classe) {
  const e = document.createElement(nom);
  if (texte !== undefined) e.textContent = texte;
  if (classe) e.className = classe;
  return e;
}

const nombre = new Intl.NumberFormat('fr-FR');

function octets(n) {
  const u = ['octets', 'Kio', 'Mio', 'Gio', 'Tio'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: i === 0 ? 0 : 1 }).format(n) + '\u00a0' + u[i];
}

function duree(s) {
  const j = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (j > 0) return j + ' j ' + h + ' h';
  if (h > 0) return h + ' h ' + m + ' min';
  if (m > 0) return m + ' min';
  return s + ' s';
}

function pourcent(a, b) {
  return b > 0 ? Math.round(a / b * 100) + ' %' : 'sans plafond';
}

function vider(e) { while (e.firstChild) e.removeChild(e.firstChild); }

function fait(dl, nom, valeur) {
  dl.append(el('dt', nom), el('dd', valeur));
}

function chiffre(dl, nom, valeur) {
  const d = el('div');
  d.append(el('dt', nom), el('dd', nombre.format(valeur)));
  dl.append(d);
}

// jauge : valeur face à son plafond. Au-delà de 80 % : ambre ; de 95 % : rouge (couleurs
// du navigateur pour <meter>).
function jauge(parent, nom, valeur, max, texte) {
  const j = el('div', undefined, 'jauge');
  const l = el('div', undefined, 'ligne');
  l.append(el('span', nom), el('span', texte));
  j.append(l);
  if (max > 0) {
    const m = document.createElement('meter');
    m.min = 0; m.max = max; m.value = Math.min(valeur, max);
    m.low = max * 0.8; m.high = max * 0.95; m.optimum = 0;
    m.setAttribute('aria-label', nom);
    j.append(m);
  }
  parent.append(j);
}

function compte(parent, nom, valeur, max) {
  jauge(parent, nom, valeur, max, nombre.format(valeur) + ' / ' + nombre.format(max));
}

function afficher(e) {
  const s = e.sante;
  gele = s.creations_gelees;

  const p = $('pastilles');
  vider(p);
  p.append(el('li', 'Serveur en marche', 'ok'));
  p.append(gele ? el('li', 'Créations gelées', 'attention') : el('li', 'Créations ouvertes', 'ok'));
  p.append(s.alerte_signalements
    ? el('li', 'Signalements : 5 ou plus dans l’heure', 'attention')
    : el('li', 'Signalements : pas d’alerte', 'ok'));
  p.append(el('li', s.salon_actif ? 'Salon activé' : 'Salon désactivé'));
  if (s.vidages_wal_rates > 0) {
    p.append(el('li', 'Vidages de la base ratés : ' + nombre.format(s.vidages_wal_rates) +
      ' (un autre programme lit-il shares.db ?)', 'attention'));
  }

  const d = $('sante');
  vider(d);
  fait(d, 'En marche depuis', duree(s.en_marche_depuis_s));
  fait(d, 'Site', s.origine || 'origine non configurée');
  fait(d, 'Version de Go', s.go);
  fait(d, 'Compilation', s.revision || 'empreinte absente');

  const st = e.stockage, sto = $('stockage');
  vider(sto);
  jauge(sto, 'Plafond de stockage utilisé', st.utilise, st.plafond,
    octets(st.utilise) + ' sur ' + octets(st.plafond) + ' (' + pourcent(st.utilise, st.plafond) + ')');
  jauge(sto, 'Disque occupé', st.disque_total - st.disque_libre, st.disque_total,
    octets(st.disque_libre) + ' libres sur ' + octets(st.disque_total));
  const sd = el('dl', undefined, 'faits');
  fait(sd, 'Partages', octets(st.octets_partages));
  fait(sd, 'Salon (pièces et conversations)', octets(st.octets_salon));
  fait(sd, 'Place restante sous le plafond', octets(st.restant));
  fait(sd, 'Dont réservée aux nouveaux venus', octets(st.reserve_nouveaux_venus));
  sto.append(sd);

  const a = $('activite');
  vider(a);
  const pa = e.partages;
  chiffre(a, 'Partages prêts', pa.prets);
  chiffre(a, 'Envois en cours', pa.envois_en_cours);
  chiffre(a, 'En fin de lecture', pa.fin_de_lecture);
  if (e.salon) {
    chiffre(a, 'Salons vivants', e.salon.salons_vivants);
    chiffre(a, 'Sièges occupés', e.salon.sieges_occupes);
  }

  const u = e.usage, us = $('usage-chiffres');
  $('usage-note').textContent = 'Compté depuis ' + duree(s.en_marche_depuis_s)
    + ', en mémoire seulement : rien par personne ni par partage, rien sur disque, et tout repart de zéro au redémarrage.';
  vider(us);
  chiffre(us, 'Partages créés', u.partages_crees);
  chiffre(us, 'Envois terminés', u.envois_termines);
  chiffre(us, 'Déverrouillages', u.deverrouillages);
  chiffre(us, 'Destructions demandées', u.destructions_demandees);
  chiffre(us, 'Effacés par l’entretien', u.effaces_par_entretien);
  chiffre(us, 'Expéditeurs distincts aujourd’hui', u.expediteurs_du_jour);
  if (s.paiement_actif) {
    chiffre(us, 'Partages payants Plus', u.partages_payants[0]);
    chiffre(us, 'Partages payants Pro', u.partages_payants[1]);
  }
  if (e.salon) {
    chiffre(us, 'Salons créés', u.salons_crees);
    chiffre(us, 'Entrées dans un salon', u.entrees_salon);
  }
  const ud = $('usage-details');
  vider(ud);
  fait(ud, 'Volume chiffré reçu', octets(u.octets_recus));
  fait(ud, 'Volume chiffré servi', octets(u.octets_servis));
  fait(ud, 'Requêtes refusées par la limite de débit', nombre.format(u.refus_debit));
  fait(ud, 'Plafond de sortie, par partage', octets(e.capacite.plafond_sortie_partage));
  fait(ud, 'Refus au plafond de sortie', nombre.format(u.refus_plafond_sortie));

  const c = e.capacite, ch = $('charge');
  vider(ch);
  jauge(ch, 'Envois en cours', u.envois_en_cours, c.envois_max,
    nombre.format(u.envois_en_cours) + ' / ' + nombre.format(c.envois_max) + ' (pic ' + nombre.format(u.envois_pic) + ')');
  jauge(ch, 'Lectures en cours', u.lectures_en_cours, c.lectures_max,
    nombre.format(u.lectures_en_cours) + ' / ' + nombre.format(c.lectures_max) + ' (pic ' + nombre.format(u.lectures_pic) + ')');
  compte(ch, 'Surveillances tenues', c.surveillances, c.surveillances_max);
  compte(ch, 'Appels disque en cours', c.appels_disque, c.appels_disque_max);
  if (e.salon) {
    compte(ch, 'Connexions du salon', e.salon.connexions, c.websocket_max);
    compte(ch, 'Salons vivants', e.salon.salons_vivants, e.salon.salons_max);
    compte(ch, 'Trames du salon en mémoire', e.salon.trames_en_memoire, e.salon.trames_max);
  }
  const cd = el('dl', undefined, 'faits');
  fait(cd, 'Octrois de lecture actifs', nombre.format(c.octrois_lecture));
  fait(cd, 'Budgets de lecture actifs', nombre.format(c.budgets_lecture));
  ch.append(cd);

  const m = e.memoire, me = $('memoire');
  vider(me);
  jauge(me, 'Mémoire', m.utilisee, m.limite,
    m.limite > 0 ? octets(m.utilisee) + ' sur ' + octets(m.limite) : octets(m.utilisee) + ' (sans limite)');
  const md = el('dl', undefined, 'faits');
  fait(md, 'Goroutines', nombre.format(m.goroutines));
  fait(md, 'Fils du système', m.fils_systeme > 0 ? nombre.format(m.fils_systeme) : 'illisible ici');
  fait(md, 'Passes du ramasse-miettes', nombre.format(m.passes_gc));
  fait(md, 'Dernière pause', (m.derniere_pause_gc_ns / 1e6).toFixed(2).replace('.', ',') + '\u00a0ms');
  if (e.salon) fait(md, 'Paniques récupérées (entretien du salon)', nombre.format(e.salon.paniques_entretien));
  me.append(md);

  appels(e);
  categories(u);
  sections(s);
  if (!armeGel) boutonGel();
}

// appels : relais et jetons (configuration), salons aux appels ouverts, compteurs depuis le
// démarrage. Le serveur ne voit pas les appels eux-mêmes.
function appels(e) {
  const s = e.sante, u = e.usage;
  $('carte-appels').hidden = !s.salon_actif;
  const p = $('appels-pastilles');
  vider(p);
  p.append(s.relais_turn ? el('li', 'Relais configuré', 'ok') : el('li', 'Relais non configuré'));
  p.append(s.appels_offerts ? el('li', 'Appels proposés (offres payantes)', 'ok')
    : el('li', s.relais_turn ? 'Appels non proposés : paiement fermé' : 'Appels non proposés'));
  const d = $('appels');
  vider(d);
  if (e.salon) fait(d, 'Salons aux appels ouverts', nombre.format(e.salon.salons_appels_ouverts));
  fait(d, 'Appels ouverts par un jeton, depuis le démarrage', nombre.format(u.appels_ouverts));
  fait(d, 'Identifiants du relais donnés, depuis le démarrage', nombre.format(u.identifiants_turn));
}

// ----- Paiement (SHH_PAIEMENT=1) -----

const PRESTATAIRES = [['stripe', 'Stripe (carte)'], ['paypal', 'PayPal'], ['nowpayments', 'NOWPayments (crypto)']];

function afficherPaiement(a) {
  suspendues = a.ventes_suspendues;
  const p = $('pass');
  vider(p);
  chiffre(p, 'Pass Plus valables', a.pass_plus);
  chiffre(p, 'Pass Pro valables', a.pass_pro);
  chiffre(p, 'Pass révoqués gardés', a.pass_revoques);
  chiffre(p, 'Abonnements qui se renouvellent', a.abonnements_renouveles);
  const c = $('commandes');
  vider(c);
  compte(c, 'Commandes récentes en attente (4 h)', a.commandes_recentes, a.commandes_recentes_max);
  const cd = el('dl', undefined, 'faits');
  fait(cd, 'Commandes en attente de paiement (7 j)', nombre.format(a.commandes_en_attente));
  fait(cd, 'Anomalies gardées (montant inattendu)', nombre.format(a.anomalies_gardees));
  c.append(cd);
  if (a.anomalies_gardees > 0) {
    c.append(el('p', 'Anomalie : un paiement confirmé n’avait pas le montant ou la devise attendus ; rien n’a été crédité. Vérifier chez le prestataire.', 'note'));
  }

  const j = $('jetons');
  vider(j);
  chiffre(j, 'Émis Plus', a.jetons_emis[0]);
  chiffre(j, 'Émis Pro', a.jetons_emis[1]);
  chiffre(j, 'Dépensés Plus', a.jetons_depenses[0]);
  chiffre(j, 'Dépensés Pro', a.jetons_depenses[1]);
  const jd = $('jetons-details');
  vider(jd);
  fait(jd, 'Rendus (création refusée après la dépense)', nombre.format(a.jetons_rendus));
  if (!a.jetons_actif) fait(jd, 'Émission', 'non configurée');

  const tb = $('prestataires');
  vider(tb);
  for (const [cle, nom] of PRESTATAIRES) {
    const x = a[cle];
    const tr = el('tr', undefined, x.webhooks_refuses > 0 || x.anomalies > 0 ? 'grave' : undefined);
    const th = el('th', nom);
    th.scope = 'row';
    const etat = !x.configure ? 'non configuré' : (x.vendable ? 'vend' : 'webhooks seulement');
    tr.append(th, el('td', etat), el('td', nombre.format(x.commandes), 'n'), el('td', nombre.format(x.paiements_credites), 'n'),
      el('td', nombre.format(x.anomalies), 'n'), el('td', nombre.format(x.revocations), 'n'),
      el('td', nombre.format(x.webhooks_refuses), 'n'));
    tb.append(tr);
  }
  $('revocations-main').textContent = 'Révocations à la main (shhdrop admin paiement revoquer) depuis le démarrage : ' +
    nombre.format(a.revocations_a_la_main) + '.';
  if (!armeVentes) boutonVentes();
}

function boutonVentes() {
  $('ventes').textContent = suspendues ? 'Rétablir les ventes' : 'Suspendre les ventes';
  $('ventes-etat').textContent = suspendues
    ? 'Suspendues jusqu’au prochain redémarrage : aucune nouvelle commande. Les paiements en cours sont crédités, les pass payés gardent leurs droits.'
    : 'Ouvertes. Suspendre refuse les nouvelles commandes jusqu’au redémarrage ; les paiements en cours et les pass payés ne sont pas touchés.';
}

function boutonGel() {
  $('gel').textContent = gele ? 'Rétablir les créations' : 'Geler les créations';
  $('gel-etat').textContent = gele
    ? 'Gelées : aucun nouveau partage ni salon. Ce qui existe reste lisible.'
    : 'Ouvertes. Geler est réversible et ne touche pas ce qui existe.';
}

// fermer : le jeton est oublié, la minuterie arrêtée, et la page revient à la saisie. Appelée
// dès qu'une réponse refuse le jeton (404 : ce qui répond n'est pas, ou plus, le serveur qui le
// connaît) ou après trois lectures d'état sans réponse de suite (tunnel coupé) : sinon l'onglet
// renverrait le jeton toutes les 5 secondes à quiconque répond ensuite sur ce port.
function fermer(message) {
  jeton = '';
  echecs = 0;
  if (minuterie) { clearInterval(minuterie); minuterie = 0; }
  $('tableau').hidden = true;
  $('perdu').hidden = true;
  $('entree').hidden = false;
  $('fraicheur').textContent = '';
  $('entree-erreur').textContent = message;
}

// Onglet fermé, quitté ou mis en cache par le navigateur : le jeton ne survit pas.
addEventListener('pagehide', () => fermer(''));

async function appel(methode, chemin, corps) {
  if (!jeton) throw new Error('sans jeton');
  const r = await fetch(chemin, {
    method: methode,
    headers: corps === undefined
      ? { Authorization: 'Bearer ' + jeton }
      : { Authorization: 'Bearer ' + jeton, 'Content-Type': 'text/plain' },
    body: corps, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
  });
  return { ok: r.ok, statut: r.status, json: await r.json().catch(() => null) };
}

// rafraichir : 'ok', 'refus' (le serveur a répondu sans accepter le jeton) ou 'injoignable'.
async function rafraichir() {
  let r;
  try {
    r = await appel('GET', '/api/etat');
  } catch {
    $('perdu').hidden = false;
    return 'injoignable';
  }
  if (!r.ok || !r.json) return r.statut === 404 ? 'refus' : 'injoignable';
  try {
    afficher(r.json);
  } catch {
    return 'refus'; // réponse qui n'a pas la forme de l'état : ce n'est pas notre serveur
  }
  if (comptesActifs) {
    let c;
    try { c = await appel('GET', '/api/comptes'); } catch { return 'injoignable'; }
    if (c.statut === 404) return 'refus';
    if (c.ok && c.json) afficherComptes(c.json);
  }
  if (paiementActif) {
    let c;
    try { c = await appel('GET', '/api/paiement'); } catch { return 'injoignable'; }
    if (c.statut === 404) return 'refus';
    if (c.ok && c.json) afficherPaiement(c.json);
  }
  $('perdu').hidden = true;
  $('fraicheur').textContent = 'Lu à ' + new Date().toLocaleTimeString('fr-FR') + ', relu toutes les 5 secondes. Rien n’est enregistré.';
  return 'ok';
}

// relire : lecture périodique, et après chaque action. Refus : fermeture tout de suite ; trois
// lectures sans réponse de suite : fermeture aussi.
async function relire() {
  if (!jeton) return;
  const r = await rafraichir();
  if (!jeton) return; // fermée entretemps
  if (r === 'ok') { echecs = 0; return; }
  if (r === 'refus') {
    fermer('Session fermée : le serveur a refusé le jeton (redémarré, ou autre programme sur ce port). Le jeton a été oublié.');
    return;
  }
  $('perdu').hidden = false;
  if (++echecs >= 3) fermer('Session fermée : serveur injoignable trois fois de suite. Le jeton a été oublié ; rouvrir le tunnel, puis le saisir de nouveau.');
}

$('entree').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  jeton = $('jeton').value.trim();
  $('jeton').value = '';
  $('entree-erreur').textContent = '';
  if (minuterie) { clearInterval(minuterie); minuterie = 0; }
  echecs = 0;
  if (await rafraichir() === 'ok') {
    $('entree').hidden = true;
    $('tableau').hidden = false;
    minuterie = setInterval(relire, 5000);
    chargerSignales();
    if (comptesActifs) chargerBannis();
  } else {
    fermer('Refusé : jeton faux, ou serveur injoignable.');
    $('jeton').focus();
  }
});

// Geler et détruire demandent un second appui dans les 5 secondes.
$('gel').addEventListener('click', async () => {
  const b = $('gel');
  if (!armeGel) {
    b.textContent = gele ? 'Confirmer : rétablir' : 'Confirmer : geler';
    armeGel = setTimeout(() => { armeGel = 0; boutonGel(); }, 5000);
    return;
  }
  clearTimeout(armeGel); armeGel = 0;
  b.disabled = true;
  const r = await appel('POST', gele ? '/api/degeler' : '/api/geler').catch(() => ({ ok: false }));
  b.disabled = false;
  $('resultat').textContent = r.ok ? (gele ? 'Créations rétablies.' : 'Créations gelées.') : 'Échec : rien n’a changé.';
  await relire();
  boutonGel();
});

// Suspendre ou rétablir les ventes : second appui dans les 5 secondes, comme le gel.
$('ventes').addEventListener('click', async () => {
  const b = $('ventes');
  if (!armeVentes) {
    b.textContent = suspendues ? 'Confirmer : rétablir' : 'Confirmer : suspendre';
    armeVentes = setTimeout(() => { armeVentes = 0; boutonVentes(); }, 5000);
    return;
  }
  clearTimeout(armeVentes); armeVentes = 0;
  b.disabled = true;
  const r = await appel('POST', suspendues ? '/api/paiement/retablir' : '/api/paiement/suspendre').catch(() => ({ ok: false }));
  b.disabled = false;
  $('resultat').textContent = r.ok ? (suspendues ? 'Ventes rétablies.' : 'Ventes suspendues jusqu’au prochain redémarrage.') : 'Échec : rien n’a changé.';
  await relire();
  boutonVentes();
});

$('detruire').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const b = $('detruire-bouton');
  if (!armeDetruire) {
    b.textContent = 'Confirmer la destruction définitive';
    armeDetruire = setTimeout(() => { armeDetruire = 0; b.textContent = 'Détruire ce lien'; }, 5000);
    return;
  }
  clearTimeout(armeDetruire); armeDetruire = 0;
  b.textContent = 'Détruire ce lien';
  const lien = $('lien').value.trim();
  $('lien').value = '';
  b.disabled = true;
  const r = await appel('POST', '/api/detruire', lien).catch(() => ({ ok: false, statut: 0, json: null }));
  b.disabled = false;
  const res = $('resultat');
  if (r.ok && r.json && r.json.detruit === 'partage') res.textContent = '1 partage détruit.';
  else if (r.ok && r.json && r.json.detruit === 'salon' && r.json.reste) {
    res.textContent = '1 salon détruit : plus personne ne peut y entrer ni y lire. L’effacement d’un de ses fichiers se termine en arrière-plan (repris chaque seconde).';
  } else if (r.ok && r.json && r.json.detruit === 'salon') res.textContent = '1 salon détruit.';
  else if (r.ok) res.textContent = 'Introuvable : déjà détruit, expiré, ou lien inconnu. Rien n’a été détruit.';
  else if (r.statut === 400) res.textContent = 'Ce n’est pas un lien de partage ou de salon. Rien n’a été détruit.';
  else res.textContent = 'Échec : le serveur n’a pas confirmé la destruction.';
  relire();
});

// ---------------------------------------------------------------------------------------
// Lot 7 : signalements, bannissements, comptes (conception du compte §21.14). La page ne
// reçoit jamais d'adresse, de pseudo, de lien ni d'identifiant de salon : seulement des
// nombres, des références de 10 minutes et des identifiants de bannissement « B-… ».

const CATEGORIES = ['Terrorisme', 'Abus sexuels sur mineurs', 'Contenu sexuel non consenti', 'Violence ou menaces',
  'Haine ou discrimination', 'Harcèlement', 'Piratage ou logiciel malveillant', 'Arnaque',
  'Données personnelles exposées', 'Autre'];
const DUREES = [[1095, '3 ans'], [365, '1 an'], [30, '30 jours']];
const FILTRES = [['', 'Tous'], ['actifs', 'Actifs'], ['suspendus', 'Suspendus'], ['bientot', 'Échéant sous 30 jours']];

let comptesActifs = false;
let salonsActifs = false;
let paiementActif = false;
let filtre = '';
let page = 0;
let totalBannis = 0;

function option(select, valeur, texte, choisie) {
  const o = el('option', texte);
  o.value = String(valeur);
  if (choisie) o.selected = true;
  select.append(o);
}

function remplirDurees(select) {
  vider(select);
  for (const [j, t] of DUREES) option(select, j, t, j === 1095);
}

function remplirMotifs(select, choisi) {
  vider(select);
  CATEGORIES.forEach((c, i) => option(select, i + 1, c, i + 1 === choisi));
}

function dateFr(d) {
  if (!d) return '';
  const [a, m, j] = d.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, j)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function palier(p) { return p === 'confirme' ? 'Confirmé' : 'Récent'; }

// sections : onglets et cartes du compte montrés seulement avec SHH_COMPTES=1.
function sections(s) {
  salonsActifs = s.salon_actif;
  comptesActifs = !!s.comptes_actif;
  for (const id of ['onglet-bannissements', 'onglet-comptes', 'bannissements', 'comptes', 'carte-bannir',
    'carte-bannis', 'carte-comptes']) {
    $(id).hidden = !comptesActifs;
  }
  $('carte-signales').hidden = !salonsActifs;
  paiementActif = !!s.paiement_actif;
  for (const id of ['onglet-paiement', 'paiement', 'carte-pass', 'carte-jetons', 'carte-prestataires', 'action-ventes']) {
    $(id).hidden = !paiementActif;
  }
}

// categories : tableau 10 lignes × partage / salon (compteurs en mémoire, depuis le démarrage).
function categories(u) {
  const tb = $('categories');
  vider(tb);
  const p = u.signalements_partage || [], sa = u.signalements_salon || [];
  CATEGORIES.forEach((c, i) => {
    const tr = el('tr', undefined, i < 2 && (p[i] || sa[i]) ? 'grave' : undefined);
    const th = el('th', c);
    th.scope = 'row';
    tr.append(th, el('td', nombre.format(p[i] || 0), 'n'), el('td', nombre.format(sa[i] || 0), 'n'));
    tb.append(tr);
  });
}

// confirmer : toute action qui détruit, bannit ou lève demande un second appui dans les
// 5 secondes, sur le même bouton (texte « Confirmer : … »).
function confirmer(bouton, texte, action) {
  bouton.addEventListener('click', async (ev) => {
    ev.preventDefault();
    if (!bouton.dataset.arme) {
      bouton.dataset.texte = bouton.textContent;
      bouton.dataset.arme = '1';
      bouton.textContent = 'Confirmer : ' + texte;
      bouton.classList.add('arme');
      bouton.minuterie = setTimeout(() => desarmer(bouton), 5000);
      return;
    }
    desarmer(bouton);
    bouton.disabled = true;
    try { await action(); } finally { bouton.disabled = false; }
  });
}

function desarmer(b) {
  clearTimeout(b.minuterie);
  if (b.dataset.arme) b.textContent = b.dataset.texte;
  delete b.dataset.arme;
  b.classList.remove('arme');
}

// envoyer : corps JSON (jamais dans l'URL). Refus du jeton (404) : session fermée. Rend la
// réponse, ou null si la session vient d'être fermée.
async function envoyer(methode, chemin, objet) {
  const r = await appel(methode, chemin, objet === undefined ? undefined : JSON.stringify(objet))
    .catch(() => ({ ok: false, statut: 0, json: null }));
  if (r.statut === 404) {
    fermer('Session fermée : le serveur a refusé le jeton. Le jeton a été oublié.');
    return null;
  }
  return r;
}

function messageErreur(r) {
  const e = r.json && r.json.error;
  if (r.statut === 429) return 'Refusé : 20 bannissements par heure au plus (garde-fou). Réessayer plus tard.';
  if (e === 'lien_invalide') return 'Ce n’est pas un lien d’invitation de salon. Rien n’a été fait.';
  if (e === 'deja_banni') return 'Déjà banni : ' + ligneBan(r.json.ban) + '. Agir sur ce bannissement dans la liste.';
  if (e === 'bad_request') return 'Demande refusée : valeur hors des bornes. Rien n’a été fait.';
  return 'Échec : le serveur n’a pas confirmé. Rien n’est sûr : relire la liste.';
}

function ligneBan(b) {
  if (!b) return 'effacé';
  return b.id + ', ' + (b.actif ? 'actif' : 'suspendu') + ', jusqu’au ' + dateFr(b.jusqu) + ', motif ' + CATEGORIES[b.motif - 1];
}

// ----- Salons signalés -----

function resume(cats) {
  const p = [];
  cats.forEach((n, i) => { if (n > 0) p.push(n + ' × ' + CATEGORIES[i]); });
  return p.join(', ');
}

function dominante(cats) {
  let m = 9;
  cats.forEach((n, i) => { if (n > cats[m] || (n === cats[m] && n > 0 && i < m)) m = i; });
  return m + 1;
}

async function chargerSignales() {
  if (!salonsActifs) return;
  const r = await envoyer('GET', '/api/signalements');
  if (!r) return;
  const ul = $('signales');
  vider(ul);
  if (!r.ok || !r.json) { $('signales-resultat').textContent = 'Lecture impossible.'; return; }
  if (r.json.salons.length === 0) ul.append(el('li', 'Aucun salon signalé en cours.', 'vide'));
  for (const s of r.json.salons) ul.append(ligneSignale(s));
}

function ligneSignale(s) {
  const li = el('li', undefined, s.categories[0] + s.categories[1] > 0 ? 'grave' : undefined);
  li.append(el('p', resume(s.categories), 'tete'));
  li.append(el('p', s.sieges + ' sur ' + s.places + ' places occupées · s’efface ' +
    (s.efface === 'moins_6h' ? 'dans moins de 6 h' : 'dans 6 à 24 h'), 'meta'));
  const c = s.createur;
  li.append(el('p', c
    ? 'Créateur : ' + palier(c.palier) + ', ' + c.anciennete_jours + ' j d’ancienneté, ' + s.autres_salons +
      ' autre(s) salon(s) vivant(s)' + (c.banni ? ', déjà banni' : '')
    : 'Créateur : sans compte', 'meta'));
  const outils = el('div', undefined, 'outils');
  const res = $('signales-resultat');
  const detruire = el('button', 'Détruire le salon', 'detruire');
  detruire.type = 'button';
  confirmer(detruire, 'détruire ce salon pour tous', async () => {
    const r = await envoyer('POST', '/api/salons/action', { ref: s.ref, action: 'detruire' });
    if (!r) return;
    if (r.ok && r.json && r.json.introuvable) res.textContent = 'Introuvable : déjà fini, ou référence échue (actualiser).';
    else if (r.ok && r.json && r.json.detruit) res.textContent = r.json.reste ? '1 salon détruit ; un fichier s’efface en arrière-plan.' : '1 salon détruit.';
    else res.textContent = messageErreur(r);
    chargerSignales();
    relire();
  });
  outils.append(detruire);
  if (c && comptesActifs) {
    const duree = el('select');
    duree.setAttribute('aria-label', 'Durée du bannissement');
    remplirDurees(duree);
    const motif = el('select');
    motif.setAttribute('aria-label', 'Motif');
    remplirMotifs(motif, dominante(s.categories));
    const bannir = el('button', 'Bannir le créateur', 'detruire');
    bannir.type = 'button';
    confirmer(bannir, 'bannir le créateur et fermer ses salons', async () => {
      const r = await envoyer('POST', '/api/salons/action', { ref: s.ref, action: 'bannir', duree_jours: Number(duree.value), motif: Number(motif.value) });
      if (!r) return;
      if (r.ok && r.json && r.json.banni === 'compte') {
        res.textContent = 'Créateur banni (' + ligneBan(r.json.ban) + ') ; ' + (r.json.salons_fermes || 0) + ' salon(s) fermé(s), sessions fermées.';
      } else if (r.ok && r.json && (r.json.banni === 'aucun' || r.json.introuvable)) {
        res.textContent = 'Personne à bannir : salon sans compte, fini, ou référence échue.';
      } else res.textContent = messageErreur(r);
      chargerSignales();
      chargerBannis();
    });
    const anc = el('button', 'Rendre l’ancienneté', 'discret');
    anc.type = 'button';
    confirmer(anc, 'rendre l’ancienneté', async () => {
      const r = await envoyer('POST', '/api/salons/action', { ref: s.ref, action: 'anciennete' });
      if (!r) return;
      res.textContent = r.ok && r.json && r.json.anciennete === 'rendue' ? 'Ancienneté rendue au créateur.'
        : (r.ok ? 'Rien à rendre : salon sans compte ou fini.' : messageErreur(r));
      chargerSignales();
    });
    outils.append(duree, motif, bannir, anc);
  }
  li.append(outils);
  return li;
}

// ----- Bannissements -----

function boutonsFiltre() {
  const f = $('filtres');
  vider(f);
  for (const [v, t] of FILTRES) {
    const b = el('button', t);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(v === filtre));
    b.addEventListener('click', () => { filtre = v; page = 0; boutonsFiltre(); chargerBannis(); });
    f.append(b);
  }
}

async function chargerBannis() {
  if (!comptesActifs) return;
  const r = await envoyer('POST', '/api/bannis', { filtre, page });
  if (!r) return;
  const ul = $('bannis');
  vider(ul);
  if (!r.ok || !r.json) { $('bannis-resultat').textContent = messageErreur(r); return; }
  totalBannis = r.json.total;
  const debut = page * r.json.par_page;
  $('bannis-total').textContent = totalBannis === 0 ? 'Aucun bannissement.'
    : nombre.format(totalBannis) + ' bannissement(s) ; ' + (debut + 1) + ' à ' + (debut + r.json.bannis.length) + ' ici.';
  $('page-avant').disabled = page === 0;
  $('page-apres').disabled = debut + r.json.bannis.length >= totalBannis;
  for (const b of r.json.bannis) ul.append(ligneBanni(b));
}

function demain() { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
function dansCinqAns() { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() + 5); return d.toISOString().slice(0, 10); }

function ligneBanni(b) {
  const li = el('li');
  const tete = el('p', undefined, 'tete');
  tete.append(el('span', b.id, 'code'), document.createTextNode(' · '),
    el('span', b.actif ? 'actif' : 'suspendu', b.actif ? 'etat-actif' : 'etat-suspendu'));
  li.append(tete);
  li.append(el('p', 'Du ' + dateFr(b.debut) + ' au ' + dateFr(b.jusqu) + ' · motif : ' + CATEGORIES[b.motif - 1] +
    ' · ' + b.salons_fermes + ' salon(s) fermé(s)', 'meta'));
  const outils = el('div', undefined, 'outils');
  const action = (nom, objet) => async () => {
    const r = await envoyer('POST', '/api/bannis/action', Object.assign({ id: b.id, action: nom }, objet));
    if (!r) return;
    const res = $('bannis-resultat');
    if (r.ok && r.json && r.json.introuvable) res.textContent = 'Introuvable : déjà levé ou échu.';
    else if (r.ok && r.json) res.textContent = 'Fait. Avant : ' + ligneBan(r.json.avant) + '. Après : ' + ligneBan(r.json.apres) + '.';
    else res.textContent = messageErreur(r);
    chargerBannis();
  };
  const bascule = el('button', b.actif ? 'Suspendre' : 'Réactiver', b.actif ? 'attention' : 'detruire');
  bascule.type = 'button';
  if (b.actif) {
    bascule.addEventListener('click', action('suspendre'));
  } else {
    confirmer(bascule, 'réactiver (sessions et salons du compte fermés)', action('reactiver'));
  }
  const date = el('input');
  date.type = 'date';
  date.min = demain();
  date.max = dansCinqAns();
  date.value = b.jusqu;
  date.setAttribute('aria-label', 'Nouvelle échéance (' + b.id + ')');
  const ech = el('button', 'Changer l’échéance', 'discret');
  ech.type = 'button';
  confirmer(ech, 'nouvelle échéance', () => action('echeance', { jusqu: date.value })());
  const lever = el('button', 'Lever', 'detruire');
  lever.type = 'button';
  confirmer(lever, 'lever (ligne effacée, sans retour ici)', action('lever'));
  const annuler = el('button', 'Annuler (erreur)', 'detruire');
  annuler.type = 'button';
  confirmer(annuler, 'annuler et rendre l’ancienneté', action('annuler'));
  outils.append(bascule, date, ech, lever, annuler);
  li.append(outils);
  return li;
}

$('page-avant').addEventListener('click', () => { if (page > 0) { page--; chargerBannis(); } });
$('page-apres').addEventListener('click', () => { page++; chargerBannis(); });
$('bannis-actualiser').addEventListener('click', () => chargerBannis());
$('signales-actualiser').addEventListener('click', () => chargerSignales());

remplirDurees($('bannir-duree'));
remplirMotifs($('bannir-motif'), 10);
boutonsFiltre();

// Bannir par lien d'invitation : le champ est vidé avant l'envoi.
confirmer($('bannir-bouton'), 'bannir (sessions et salons fermés)', async () => {
  const champ = $('bannir-cible');
  const v = champ.value.trim();
  champ.value = '';
  const res = $('bannir-resultat');
  if (!v) { res.textContent = 'Rien à bannir : champ vide.'; return; }
  const corps = { duree_jours: Number($('bannir-duree').value), motif: Number($('bannir-motif').value) };
  corps.lien = v;
  const r = await envoyer('POST', '/api/bannir', corps);
  if (!r) return;
  if (r.ok && r.json && r.json.banni === 'compte') {
    res.textContent = 'Compte banni (' + ligneBan(r.json.ban) + ') ; ' + (r.json.salons_fermes || 0) + ' salon(s) fermé(s), sessions fermées.';
  } else if (r.ok && r.json && r.json.banni === 'aucun') {
    res.textContent = 'Salon créé sans compte : personne à bannir. Le détruire dans « Actions ».';
  } else if (r.ok && r.json && r.json.introuvable) {
    res.textContent = 'Introuvable : aucun salon pour ce lien (fini ou inconnu). Rien n’a été fait.';
  } else res.textContent = messageErreur(r);
  chargerBannis();
});
$('bannir').addEventListener('submit', (ev) => { ev.preventDefault(); $('bannir-bouton').click(); });

// ----- Comptes -----

function afficherComptes(a) {
  const c = $('comptes-chiffres');
  vider(c);
  chiffre(c, 'Comptes (plafond ' + nombre.format(a.comptes_max) + ')', a.comptes);
  chiffre(c, 'Inscrits aujourd’hui (UTC)', a.inscrits_aujourdhui);
  chiffre(c, 'Inscrits ces 7 jours', a.inscrits_7_jours);
  chiffre(c, 'Récents (< 7 j d’ancienneté)', a.neufs);
  chiffre(c, 'Confirmés', a.confirmes);
  chiffre(c, 'Passkeys', a.passkeys);
  chiffre(c, 'Dont ouvrant les données (PRF)', a.passkeys_prf);
  chiffre(c, 'Comptes sans passkey synchronisable', a.comptes_sans_passkey_synchronisable);
  chiffre(c, 'Sessions ouvertes', a.sessions);
  chiffre(c, 'Dont « rester connecté »', a.sessions_persistantes);
  chiffre(c, 'Effacés (inactivité, dernier passage)', a.effaces_inactivite_dernier_passage);
  chiffre(c, 'Bannis actifs', a.bannis_actifs);
  chiffre(c, 'Bannis suspendus', a.bannis_suspendus);
  chiffre(c, 'Échéant sous 30 j', a.bannis_echeant_30_jours);
  chiffre(c, 'Salons vivants créés par un compte', a.salons_de_comptes);
  const an = $('comptes-anciennete');
  vider(an);
  ['Moins de 7 j', '7 à 29 j', '1 à 6 mois', '6 à 12 mois', 'Plus de 12 mois'].forEach((t, i) => chiffre(an, t, a.anciennete[i]));
  const u = $('comptes-usage');
  vider(u);
  chiffre(u, 'Comptes créés', a.inscriptions);
  chiffre(u, 'Connexions par passkey', a.connexions);
  chiffre(u, 'Échecs de connexion', a.echecs_connexion);
  chiffre(u, 'Récupérations par la clé', a.recuperations);
  chiffre(u, 'Suppressions de compte', a.suppressions);
}
