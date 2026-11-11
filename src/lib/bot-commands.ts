// The music bot's chat commands, shown as a list when a message starts with "!"
export interface BotCommand {
  names: string[];   // the first is the main name, the rest are short forms (without the "!")
  args?: string;     // what follows the name, "[...]" is optional
  desc: string;
}
export interface BotCommandGroup { title: string; commands: BotCommand[] }

export const BOT_COMMAND_GROUPS: BotCommandGroup[] = [
  { title: 'Control', commands: [
    { names: ['web'], desc: 'Get the URL of the web interface, if enabled.' },
    { names: ['play', 'p'], args: '[{num}] [{start_from}]', desc: 'Resume from pausing / start to play (the num-th song if num is given).' },
    { names: ['pause'], desc: 'Pause.' },
    { names: ['stop'], desc: 'Stop playing.' },
    { names: ['skip'], desc: 'Jump to the next song.' },
    { names: ['last'], desc: 'Jump to the last song.' },
    { names: ['volume'], args: '{volume}', desc: 'Get or change the volume (from 0 to 100).' },
    { names: ['mode'], args: '[{mode}]', desc: 'Get or set the playback mode: one-shot (remove item once played), repeat (loop through the playlist), random (randomize the playlist), autoplay (randomly grab something from the music library).' },
    { names: ['duck'], args: 'on/off', desc: 'Enable or disable the ducking function.' },
    { names: ['duckv'], args: '{volume}', desc: 'Set the volume of the bot when ducking is activated.' },
    { names: ['duckthres'], args: '{threshold}', desc: 'Set the volume threshold that activates ducking (3000 by default).' },
    { names: ['oust'], desc: 'Stop playing and go to the default channel.' }
  ] },
  { title: 'Playlist', commands: [
    { names: ['now', 'np'], desc: 'Display the current song.' },
    { names: ['queue'], desc: 'Display the items in the playlist.' },
    { names: ['tag'], args: '{tags}', desc: 'Add all items with the tags {tags}, separated by ",".' },
    { names: ['file', 'f'], args: '{path/folder/keyword}', desc: 'Add a single file to the playlist by its path or a keyword in its path.' },
    { names: ['filematch', 'fm'], args: '{pattern}', desc: 'Add all files that match the regex {pattern}.' },
    { names: ['url'], args: '{url}', desc: 'Add YouTube or SoundCloud music.' },
    { names: ['playlist'], args: '{url} [{offset}]', desc: 'Add all items of a YouTube or SoundCloud playlist, starting with the {offset}-th item.' },
    { names: ['radio'], args: '{url}', desc: 'Append a radio {url} to the playlist.' },
    { names: ['rbquery'], args: '{keyword}', desc: 'Query radio-browser.info for a radio station.' },
    { names: ['rbplay'], args: '{id}', desc: 'Play a radio station by its {id} (e.g. !rbplay 96746).' },
    { names: ['ysearch'], args: '{keywords}', desc: 'Query YouTube. Use !ysearch -n to turn the page.' },
    { names: ['yplay'], args: '{keywords}', desc: 'Add the first YouTube search result of {keywords} to the playlist.' },
    { names: ['shortlist', 'sl'], args: '{indexes/*}', desc: 'Add the {indexes}-th item (or all items if * is given) on the shortlist.' },
    { names: ['rm'], args: '{num}', desc: 'Remove the num-th song on the playlist.' },
    { names: ['repeat'], args: '[{num}]', desc: 'Repeat the current song {num} times (1 by default).' },
    { names: ['random'], desc: 'Randomize the playlist.' }
  ] },
  { title: 'Music library', commands: [
    { names: ['search'], args: '{keywords}', desc: 'Find items with {keywords} in the music library, keywords separated by space.' },
    { names: ['listfile'], args: '[{pattern}]', desc: 'Display the available files (only those whose paths match the regex {pattern}, if given).' },
    { names: ['addtag'], args: '[{index/*}] {tags}', desc: 'Add {tags} to the {index}-th item on the playlist (the current song if omitted, or all items with *), tags separated by ",".' },
    { names: ['untag'], args: '[{index/*}] {tags}/*', desc: 'Remove {tags} (or all tags with *) from the {index}-th item on the playlist (the current song if omitted).' },
    { names: ['findtagged', 'ft'], args: '{tags}', desc: 'Find items with {tags} in the music library.' },
    { names: ['delete'], args: '{index}', desc: 'Delete the {index}-th item on the shortlist from the music library.' }
  ] },
  { title: 'Other', commands: [
    { names: ['joinme'], args: '{token}', desc: 'Join your own channel with {token}.' },
    { names: ['password'], args: '{password}', desc: 'Change your password, used to access the web interface.' }
  ] }
];

// Flat, in display order, each remembering its group
export const BOT_COMMANDS: (BotCommand & { group: string })[] =
  BOT_COMMAND_GROUPS.flatMap(g => g.commands.map(c => ({ ...c, group: g.title })));

// The commands whose name or short form starts with what was typed after "!"
export function matchBotCommands(typed: string) {
  const q = typed.toLowerCase();
  return BOT_COMMANDS.filter(c => c.names.some(n => n.startsWith(q)));
}
