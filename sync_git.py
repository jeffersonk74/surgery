import os
import subprocess
import sys

def run_command(command):
    try:
        result = subprocess.run(command, shell=True, check=True, text=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"\n❌ Erreur lors de l'exécution de : {command}")
        return False

def sync():
    print("🚀 Début de la synchronisation Git...")

    # 1. Ajout des fichiers modifiés
    print("\n📦 Étape 1 : Indexation des fichiers...")
    if not run_command("git add ."): return

    # 2. Commit local
    message = input("📝 Entrez votre message de commit (ou Entrée pour 'Mise à jour automatique') : ")
    if not message.strip():
        message = "Mise à jour automatique du projet ORCHIDEE"
    
    if not run_command(f'git commit -m "{message}"'):
        print("ℹ️ Rien à commiter, tout est déjà à jour localement.")

    # 3. Tentative de Push
    print("\n🌐 Étape 2 : Tentative d'envoi vers GitHub...")
    if run_command("git push origin main"):
        print("\n✅ Succès ! Tout est en ligne.")
    else:
        print("\n⚠️ Échec du push. Es-tu hors-ligne ?")
        print("💾 Tes modifications sont enregistrées LOCALEMENT. Tu pourras 'pusher' plus tard.")

if __name__ == "__main__":
    sync()
