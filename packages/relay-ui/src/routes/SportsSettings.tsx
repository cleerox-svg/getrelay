import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Block,
  BlockTitle,
  Button,
  List,
  ListItem,
  Navbar,
  NavbarBackLink,
  Page,
} from 'konsta/react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import type { SportsTeamMeta } from '../lib/types';

interface SubKey {
  league: 'NHL' | 'MLB';
  teamKey: string;
}

function subId(s: SubKey): string {
  return `${s.league}:${s.teamKey}`;
}

export function SportsSettings() {
  const navigate = useNavigate();
  const me = useStore((s) => s.me);
  const loadMe = useStore((s) => s.loadMe);

  const [nhl, setNhl] = useState<SportsTeamMeta[]>([]);
  const [mlb, setMlb] = useState<SportsTeamMeta[]>([]);
  const [subs, setSubs] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getSportsTeams(), api.getSportsSubs()])
      .then(([teams, mySubs]) => {
        if (cancelled) return;
        setNhl(teams.nhl);
        setMlb(teams.mlb);
        setSubs(new Set(mySubs.subs.map(subId)));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the team set whenever it changes (debounced via a flush
  // queue would be nicer, but a flat write per toggle is fine — the
  // server replaces the whole row set in one transaction).
  async function commit(next: Set<string>): Promise<void> {
    setSubs(next);
    setSaving(true);
    try {
      const payload: SubKey[] = [];
      for (const id of next) {
        const [league, ...rest] = id.split(':');
        if (league !== 'NHL' && league !== 'MLB') continue;
        payload.push({ league, teamKey: rest.join(':') });
      }
      await api.setSportsSubs(payload);
    } finally {
      setSaving(false);
    }
  }

  async function toggleTeam(league: 'NHL' | 'MLB', teamKey: string): Promise<void> {
    const id = subId({ league, teamKey });
    const next = new Set(subs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    await commit(next);
  }

  async function toggleNotify(
    key: 'sportsNotifications' | 'sportsNotifyStart' | 'sportsNotifyScore' | 'sportsNotifyFinal',
  ): Promise<void> {
    const next = !(me?.[key] ?? true);
    await api.updateMe({ [key]: next });
    await loadMe();
  }

  // Master kill switch defaults to true in the local fallback so the
  // page never reads as "everything off" while /me is in-flight.
  const master = me?.sportsNotifications ?? true;
  const startOn = me?.sportsNotifyStart ?? true;
  const scoreOn = me?.sportsNotifyScore ?? true;
  const finalOn = me?.sportsNotifyFinal ?? true;

  const nhlSorted = useMemo(() => nhl.slice(), [nhl]);
  const mlbSorted = useMemo(() => mlb.slice(), [mlb]);

  return (
    <Page>
      <Navbar
        title="Sports"
        left={
          <NavbarBackLink
            text="Profile"
            onClick={() => navigate(-1)}
          />
        }
      />

      <BlockTitle>Notifications</BlockTitle>
      <Block strong inset className="!py-0">
        <List nested>
          <ListItem
            title="Sports alerts"
            subtitle="Master switch for all sports pushes."
            after={
              <Button
                small
                outline={!master}
                onClick={() => toggleNotify('sportsNotifications')}
              >
                {master ? 'On' : 'Off'}
              </Button>
            }
          />
          <ListItem
            title="Game starting"
            subtitle="Push when a followed team's game goes live."
            after={
              <Button
                small
                outline={!startOn}
                disabled={!master}
                onClick={() => toggleNotify('sportsNotifyStart')}
              >
                {startOn ? 'On' : 'Off'}
              </Button>
            }
          />
          <ListItem
            title="Score changes"
            subtitle="Goals (NHL) and runs scored (MLB)."
            after={
              <Button
                small
                outline={!scoreOn}
                disabled={!master}
                onClick={() => toggleNotify('sportsNotifyScore')}
              >
                {scoreOn ? 'On' : 'Off'}
              </Button>
            }
          />
          <ListItem
            title="Final result"
            subtitle="Win / loss when the game ends."
            after={
              <Button
                small
                outline={!finalOn}
                disabled={!master}
                onClick={() => toggleNotify('sportsNotifyFinal')}
              >
                {finalOn ? 'On' : 'Off'}
              </Button>
            }
          />
        </List>
      </Block>

      <BlockTitle>NHL teams</BlockTitle>
      <Block strong inset className="!py-0">
        {!loaded ? (
          <div className="py-6 text-center text-sm" style={{ color: 'var(--text-dim)' }}>
            Loading teams…
          </div>
        ) : nhlSorted.length === 0 ? (
          <div className="py-6 text-center text-sm" style={{ color: 'var(--text-dim)' }}>
            No teams available.
          </div>
        ) : (
          <List nested>
            {nhlSorted.map((t) => {
              const id = subId({ league: 'NHL', teamKey: t.key });
              const on = subs.has(id);
              return (
                <ListItem
                  key={id}
                  title={t.name}
                  media={
                    t.logo ? (
                      <img
                        src={t.logo}
                        alt=""
                        width={28}
                        height={28}
                        style={{ objectFit: 'contain' }}
                      />
                    ) : (
                      <span
                        style={{
                          display: 'inline-flex',
                          width: 28,
                          height: 28,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 999,
                          background: 'var(--bubble-them, #E5E5EA)',
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {t.abbr}
                      </span>
                    )
                  }
                  after={
                    <Button
                      small
                      outline={!on}
                      disabled={saving}
                      onClick={() => toggleTeam('NHL', t.key)}
                    >
                      {on ? 'Following' : 'Follow'}
                    </Button>
                  }
                />
              );
            })}
          </List>
        )}
      </Block>

      <BlockTitle>MLB teams</BlockTitle>
      <Block strong inset className="!py-0">
        {!loaded ? (
          <div className="py-6 text-center text-sm" style={{ color: 'var(--text-dim)' }}>
            Loading teams…
          </div>
        ) : mlbSorted.length === 0 ? (
          <div className="py-6 text-center text-sm" style={{ color: 'var(--text-dim)' }}>
            No teams available.
          </div>
        ) : (
          <List nested>
            {mlbSorted.map((t) => {
              const id = subId({ league: 'MLB', teamKey: t.key });
              const on = subs.has(id);
              return (
                <ListItem
                  key={id}
                  title={t.name}
                  media={
                    t.logo ? (
                      <img
                        src={t.logo}
                        alt=""
                        width={28}
                        height={28}
                        style={{ objectFit: 'contain' }}
                      />
                    ) : (
                      <span
                        style={{
                          display: 'inline-flex',
                          width: 28,
                          height: 28,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 999,
                          background: 'var(--bubble-them, #E5E5EA)',
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {t.abbr}
                      </span>
                    )
                  }
                  after={
                    <Button
                      small
                      outline={!on}
                      disabled={saving}
                      onClick={() => toggleTeam('MLB', t.key)}
                    >
                      {on ? 'Following' : 'Follow'}
                    </Button>
                  }
                />
              );
            })}
          </List>
        )}
      </Block>

      <Block className="text-sm !mt-2 !mb-6" style={{ color: 'var(--text-dim)' }}>
        Notifications fire only for teams you follow. Turn off the master
        switch above to silence sports pushes entirely.
      </Block>
    </Page>
  );
}
