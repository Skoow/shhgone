<script lang="ts">
  // Accueil connecté (conception compte §21.15.1) : la liste de l'appareil
  // (routes/home/Inbox.svelte, qui ne connaît pas le compte) avec le profil du compte (avatar),
  // le bandeau d'après une récupération et celui d'un coffre illisible. Vu seulement par
  // routes/compte/pages.ts, donc seulement avec __COMPTES__.
  import { account } from "../../account/session.svelte";
  import Inbox from "../home/Inbox.svelte";

  const profile = $derived(account.profil ? { pseudo: account.profil.pseudo, photo: account.profil.photo } : null);
</script>

<Inbox {profile} recovered={account.recupere} vaultError={account.erreur === "coffre_illisible"} />
