# Selftbot – Dashboard Discord Selfbot

Dashboard web pour contrôler un compte Discord (selfbot) : rejoindre des salons vocaux automatiquement et envoyer des DM à tous ses amis.

## Architecture

- **Runtime**: Node.js 20
- **Framework**: Express.js + Socket.io (temps réel)
- **Selfbot**: discord.js-selfbot-v13
- **Frontend**: HTML/CSS/JS vanilla
- **Port**: 5000

## Structure du projet

```
selftbot/
├── server.js          # Serveur Express + Socket.io
├── bot.js             # Logique selfbot Discord
├── public/
│   ├── index.html     # Page de connexion (token)
│   ├── dashboard.html # Dashboard principal
│   └── style.css      # Styles globaux
├── package.json
└── .gitignore
```

## Fonctionnalités

- **Connexion par token** : l'utilisateur colle son token Discord pour se connecter
- **Voice Auto** (`!voiceauto <channelID>`) : rejoindre un salon vocal par ID
- **DM All** (`!dmall <message>`) : envoyer un DM à tous les amis avec rate-limit (1.2s)
- **Logs temps réel** : suivi des actions via Socket.io
- **Déconnexion** : bouton pour quitter proprement

## Déploiement

Configuré en VM (always-running) pour maintenir la connexion Discord active.
Commande : `node server.js`
