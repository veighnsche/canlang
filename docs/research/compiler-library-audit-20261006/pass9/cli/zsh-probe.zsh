#!/bin/zsh
zmodload zsh/zpty
zpty -b cli /bin/zsh -f
zpty -w cli 'fpath=(/usr/share/zsh/5.9/functions); autoload -Uz compinit; compinit -D; PS1="READY> "; source /Users/vince/Projects/canlang/compiler/can-completions.zsh; compdef _can can; bindkey "^I" expand-or-complete;'
sleep 4
while zpty -r cli; do :; done
zpty -w -n cli $'can completions b\t'
sleep 0.4
while zpty -r cli; do :; done
zpty -w -n cli $'\C-ucan lint --fix\t'
sleep 0.4
while zpty -r cli; do :; done
zpty -w -n cli $'\C-ucan check --format=j\t'
sleep 0.4
while zpty -r cli; do :; done
zpty -d cli
