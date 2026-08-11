# UlysesDock

Panneau latéral Windows qui surveille **ton travail** sur Jira et Bitbucket — tes tickets, tes PRs, et les notifications qui te concernent vraiment. Il se docke à droite de l'écran, se replie en une fine barre, et vit dans la zone de notification (tray).

## Fonctionnalités

- **Récap** — tes commits d'hier (lus depuis tes repos git locaux), tes tickets en cours, et les **PRs qui attendent ta réponse**. Bouton *Copier* : ton message de daily prêt à coller.
- **PRs** — toutes tes pull requests (backend + frontend), filtrables : *Open · À répondre · Validated · Changes · Merged · Declined*. Chaque PR ouverte affiche son vrai état de review :
  - 🔴 **À répondre** — le dernier commentaire humain n'est pas de toi
  - 🟢 **Approuvée** — au moins une approbation
  - 🟡 **Chez les reviewers** — tu as parlé en dernier, la balle est chez eux
  - ⚪ **Pas encore relue** — ouverte mais personne ne l'a regardée
  Les commentaires des bots (UlysesSuite) sont ignorés partout.
- **Tickets** — tes tickets assignés, groupés par statut, filtrables par projet (B2 / PMSWEB) et par statut. Clique un ticket : description + commentaires en place, et **réponds directement** depuis le panneau.
- **Notifs** — nouveaux commentaires, changements de statut et assignations sur les tickets que tu as touchés (assigné maintenant ou avant, rapporteur). Ferme avec ✕, notifications Windows pour les nouveautés. Les retours de QA (ticket qui recule) sont marqués **RETOUR** en rouge.
- **Alt+K** — affiche/masque le panneau depuis n'importe où. La croix ✕ minimise dans le tray (quitter : clic droit sur l'icône tray → Quitter).

## Installation

1. Télécharge le dernier `UlysesDock-Setup-x.y.z.exe` depuis les [Releases](https://github.com/yacinebenak/ulysesdock/releases).
2. Lance-le. Au premier démarrage, l'écran de configuration te demande :
   - **Email Jira** : ton email Septeo.
   - **Token API Jira** : crée-le sur [id.atlassian.com → Sécurité → Jetons d'API](https://id.atlassian.com/manage-profile/security/api-tokens).
   - **Bitbucket** : détecté automatiquement via le Git Credential Manager (si tu clones déjà en HTTPS, tu n'as rien à faire). Sinon, colle un access token Bitbucket dans la section *Avancé*.
3. C'est tout. L'app détecte toute seule qui tu es (compte Jira + Bitbucket).

## Configuration avancée

Le fichier `%APPDATA%\UlysesDock\config.json` est éditable (relance l'app après modification) :

| Champ | Rôle | Défaut |
|---|---|---|
| `localRepos` | Repos git locaux scannés pour le récap des commits | `IdeaProjects\backend` + `frontend` s'ils existent |
| `gitAuthor` | Filtre `--author` du récap | `git config user.name` |
| `ticketsDir` | Dossier local dont les sous-dossiers `KEY-123` enrichissent la watchlist | `IdeaProjects\tickets` s'il existe |
| `pollIntervalMs` | Fréquence de synchro | `30000` |
| `ignoreAuthors` | Auteurs (bots) ignorés partout | `["UlysesSuite"]` |

## Développement

```bash
npm install
npm start          # lance l'app en local
```

Release : pousser un tag `v*` (ex. `v1.0.1`) — GitHub Actions construit l'installeur Windows et publie la release automatiquement.

Architecture : `src/main.js` (process principal, fenêtre, tray, polling), `src/services/` (Jira, Bitbucket, git local, état — Node pur, testable), `src/ui/` (renderer vanilla HTML/CSS/JS, aucun framework, aucune dépendance externe). Le contrat complet entre les couches est décrit dans [SPEC.md](SPEC.md).

> Note : `npm install` peut échouer à extraire le binaire Electron sur certains postes (antivirus). Contournement : dézipper manuellement le fichier du cache `%LOCALAPPDATA%\electron\Cache` vers `node_modules\electron\dist` et créer `node_modules\electron\path.txt` contenant `electron.exe`.
