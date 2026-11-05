import { useState, type ReactNode } from 'react';
import { AdminLayout } from '../components/AdminLayout';
import { AppHeader } from '../components/AppHeader';
import { AvatarMenu } from '../components/AvatarMenu';
import { BackLink } from '../components/BackLink';
import { BottomTabBar } from '../components/BottomTabBar';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { CrisisPanel } from '../components/CrisisPanel';
import { CrisisStrip } from '../components/CrisisStrip';
import { Dialog } from '../components/Dialog';
import { EnvChip } from '../components/EnvChip';
import { Footer } from '../components/Footer';
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  BriefcaseIcon,
  CarIcon,
  ChatIcon,
  CheckIcon,
  ChevronRightIcon,
  FlagIcon,
  HomeIcon,
  HouseIcon,
  LockIcon,
  MailIcon,
  MapPinIcon,
  PhoneIcon,
  SendIcon,
  SoupIcon,
  UsersIcon,
  XIcon,
} from '../components/icons';
import { Logo } from '../components/Logo';
import { ModeSwitch } from '../components/ModeSwitch';
import { NeedTile } from '../components/NeedTile';
import { NeedTileOff } from '../components/NeedTileOff';
import { ProgressTrack } from '../components/ProgressTrack';
import { PublicHeader } from '../components/PublicHeader';
import { QrfPanel } from '../components/QrfPanel';
import { RadioCardGroup } from '../components/RadioCardGroup';
import { Select } from '../components/Select';
import { StatusChip } from '../components/StatusChip';
import { Stepper } from '../components/Stepper';
import { TextArea } from '../components/TextArea';
import { TextField } from '../components/TextField';

/**
 * Dev-only gallery (route /dev/components, absent from production builds). It lays out
 * every shared component and variant in the order of the Components board, for review.
 */

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-5 rounded-12 border border-line bg-white p-7"
    >
      <h2 id={id} className="font-display text-26 font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const Sub = ({ children }: { children: ReactNode }) => (
  <h3 className="text-18 font-bold">{children}</h3>
);
const Cap = ({ children }: { children: ReactNode }) => (
  <p className="text-16 text-slate">{children}</p>
);
const Row = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-wrap items-center gap-3">{children}</div>
);

function Swatch({ name, hex, note, bg }: { name: string; hex: string; note?: string; bg: string }) {
  return (
    <li className="flex flex-col gap-1.5">
      <span className="h-22 rounded-10 border border-line" style={{ background: bg }} />
      <span className="text-17 font-bold">{name}</span>
      <span className="font-mono text-16">{hex}</span>
      {note ? <span className="text-16 text-slate">{note}</span> : null}
    </li>
  );
}

const noop = () => undefined;

export default function ComponentGallery() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [role, setRole] = useState('somewhat');

  return (
    <div className="min-h-screen bg-mist">
      <title>SUAS components · dev</title>
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 pt-14 pb-18 max-sm:px-4">
        <div className="flex max-w-195 flex-col gap-2.5">
          <h1 className="heading text-48 max-sm:text-34">SUAS components</h1>
          <p className="text-20 text-slate">
            One small kit for every screen, built on the Direction A brand kit (v0.1 draft). Service
            Blue acts, Harbor frames, the four need colors name the four needs, and SOS red only
            ever means 911 or 988.
          </p>
        </div>

        <Block id="g-logo" title="Logo">
          <div className="grid grid-cols-2 gap-5 max-md:grid-cols-1">
            <div className="flex flex-wrap items-center gap-10 rounded-10 border border-line bg-white p-7">
              <Logo className="h-14" />
              <img src="/suas-mark-color.svg" alt="SUAS mark" className="size-24" />
            </div>
            <div className="flex flex-wrap items-center gap-10 rounded-10 bg-harbor p-7">
              <Logo tone="white" className="h-14" />
            </div>
          </div>
          <Cap>
            Header lockup 32 px tall, 28 px on phones. Always place the file; never retype SUAS. The
            240 px mark is for the Landing hero only.
          </Cap>
        </Block>

        <Block id="g-color" title="Color">
          <Sub>Core</Sub>
          <ul className="grid grid-cols-7 gap-3.5 max-md:grid-cols-4 max-sm:grid-cols-2">
            <Swatch
              name="Service Blue"
              hex="#1C529E"
              note="Mark, actions, links, focus ring"
              bg="#1C529E"
            />
            <Swatch name="Harbor" hex="#12325F" note="Crisis band, Serve chrome" bg="#12325F" />
            <Swatch name="Ink" hex="#101828" note="Body text, wordmark" bg="#101828" />
            <Swatch name="Slate" hex="#556274" note="Secondary text, field borders" bg="#556274" />
            <Swatch name="Mist" hex="#F2F4F7" note="App background" bg="#F2F4F7" />
            <Swatch name="Card" hex="#FFFFFF" note="Cards, surfaces" bg="#FFFFFF" />
            <Swatch name="Line" hex="#D8DEE8" note="Dividers, decorative only" bg="#D8DEE8" />
          </ul>
          <div className="grid grid-cols-2 gap-5 max-md:grid-cols-1">
            <div className="flex flex-col gap-3.5">
              <Sub>The four needs</Sub>
              <ul className="grid grid-cols-4 gap-3.5 max-md:grid-cols-2">
                <Swatch name="Transportation" hex="#2173B8" bg="#2173B8" />
                <Swatch name="Food" hex="#A65A12" bg="#A65A12" />
                <Swatch name="Temporary Shelter" hex="#3B7748" bg="#3B7748" />
                <Swatch name="Peer Support, QRF" hex="#2E7A73" bg="#2E7A73" />
              </ul>
              <Cap>
                Fills behind white icons and labels only. Never text on white, never in the mark.
              </Cap>
            </div>
            <div className="flex flex-col gap-3.5">
              <Sub>Crisis entry only</Sub>
              <ul className="grid grid-cols-2 gap-3.5">
                <Swatch name="SOS Day" hex="#B42318" bg="#B42318" />
                <Swatch name="Harbor tint" hex="#C9D6EA" note="Text on Harbor" bg="#C9D6EA" />
              </ul>
              <Cap>
                Call 911 and Call or text 988, nothing else. Routine errors use Ink, an icon and
                plain words.
              </Cap>
            </div>
          </div>
        </Block>

        <Block id="g-type" title="Type">
          <div className="grid grid-cols-2 items-end gap-5 max-md:grid-cols-1">
            <div className="flex flex-col gap-3.5">
              <p className="font-display text-72 leading-none font-bold tracking-[-0.025em] max-sm:text-44">
                What do you need?
              </p>
              <Cap>
                Public Sans 700 for headings, 600 for small headings and the QRF descriptor. Sizes
                96, 72, 54, 44, 30, 26.
              </Cap>
            </div>
            <div className="flex flex-col gap-2.5">
              <p className="text-22 font-bold">Request sent. Not confirmed yet.</p>
              <p>
                Atkinson Hyperlegible at 18 px body. It was designed for low-vision readers, so 1, l
                and I, and 0 and O stay distinct in codes and phone numbers.
              </p>
              <Cap>Body 18, labels 17, nothing under 16. Sentence case. Line height 1.5.</Cap>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {[96, 72, 54, 44, 30, 26].map((size) => (
              <p key={size} className="heading" style={{ fontSize: size }}>
                {size} px Public Sans
              </p>
            ))}
          </div>
        </Block>

        <Block id="g-btn" title="Buttons">
          <Row>
            <Button href="#g-btn">Send request</Button>
            <Button variant="secondary" href="#g-btn">
              Go back
            </Button>
            <Button variant="sos" href="tel:911">
              Call 911
            </Button>
            <Button variant="sos" href="tel:988">
              Call or text 988
            </Button>
            <Button variant="secondary" href="#g-btn">
              Cancel request
            </Button>
            <Button variant="disabled">Unavailable</Button>
            <Button variant="teal" href="#g-btn">
              Request essentials
            </Button>
            <Button
              className="outline outline-2 outline-offset-2 outline-service-blue ring-2 ring-white"
              href="#g-btn"
            >
              Keyboard focus
            </Button>
          </Row>
          <Sub>Sizes and variants</Sub>
          <Row>
            <Button size="small">Small primary</Button>
            <Button size="small" variant="secondary">
              Small secondary
            </Button>
            <Button size="form">Form 56 px</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="icon" aria-label="Close">
              <XIcon />
            </Button>
            <Button icon={<ArrowRightIcon />}>With icon</Button>
            <Button disabled>Disabled prop</Button>
          </Row>
          <div className="flex flex-wrap items-center gap-5 rounded-10 bg-harbor p-5">
            <Button variant="onHarborOutline" href="#g-btn">
              On Harbor, outline
            </Button>
            <Button variant="onHarborWhite" href="#g-btn">
              On Harbor, white
            </Button>
            <Button variant="sos" href="tel:988">
              Call or text 988
            </Button>
          </div>
          <div className="rounded-6 bg-need-peer p-6">
            <Button variant="peer" href="#g-btn" icon={<UsersIcon size={28} />}>
              Request peer support
            </Button>
          </div>
          <Cap>
            52 px tall, 56 on forms, 72 for Request peer support. Primary is Service Blue. Crisis
            buttons carry a phone icon and the number, so meaning never rests on red alone. Pass
            `href` to render a link.
          </Cap>
        </Block>

        <div className="grid grid-cols-2 gap-5 max-md:grid-cols-1">
          <Block id="g-chip" title="Status chips">
            <Row>
              <StatusChip kind="wait">Request received</StatusChip>
              <StatusChip kind="wait" marker="dot">
                Looking for a veteran
              </StatusChip>
              <StatusChip kind="wait" marker="beacon">
                Looking for a veteran
              </StatusChip>
              <StatusChip kind="info">A veteran was notified</StatusChip>
              <StatusChip kind="ok">A veteran accepted</StatusChip>
              <StatusChip kind="off" marker="ring">
                No one available yet
              </StatusChip>
              <StatusChip kind="warn">Trouble coordinating</StatusChip>
              <StatusChip kind="off">Cancelled</StatusChip>
              <StatusChip kind="stale">Verified Jul 2</StatusChip>
              <StatusChip kind="off">Coming soon</StatusChip>
              <EnvChip label="Synthetic demo data" />
            </Row>
            <Cap>
              Brand neutrals and Service Blue only. Each chip carries words and a shape. A later
              state shows only once it&apos;s recorded.
            </Cap>
          </Block>

          <Block id="g-nav" title="Navigation">
            <div className="flex flex-col gap-4">
              <ModeSwitch mode="support" className="self-start" />
              <div className="rounded-10 bg-harbor p-3.5">
                <ModeSwitch mode="serve" tone="harbor" />
              </div>
              <BackLink to="/dev/components">Back to Support</BackLink>
              <div className="flex items-center gap-4">
                <AvatarMenu displayName="Marcus T." onSignOut={noop} />
                <Cap>Avatar menu: opens the name and Sign out.</Cap>
              </div>
            </div>
            <Cap>
              Two places only: Home and Chat. In Serve mode the header turns Harbor, so you always
              know which side you&apos;re on.
            </Cap>
          </Block>
        </div>

        <Block id="g-headers" title="Headers">
          <div className="flex flex-col gap-4 overflow-hidden rounded-10 border border-line">
            <PublicHeader />
            <AppHeader
              mode="support"
              current="home"
              displayName="Marcus T."
              onSignOut={noop}
              chatUnread={0}
            />
            <AppHeader
              mode="serve"
              current="chat"
              displayName="Dee R."
              onSignOut={noop}
              chatUnread={1}
            />
          </div>
          <Cap>
            Public header, Need support header, and Serve (Harbor) header with an unread badge.
            Phones hide the nav and mode switch from the header; see Phone layout below.
          </Cap>
        </Block>

        <Block id="g-phone" title="Phone layout (640 px and below)">
          <div className="grid grid-cols-2 gap-5 max-md:grid-cols-1">
            <div className="flex flex-col gap-3.5 rounded-10 border border-line p-4">
              <ModeSwitch mode="support" fullWidth />
              <BottomTabBar mode="support" current="home" embedded />
            </div>
            <div className="flex flex-col gap-3.5 rounded-10 border border-line p-4">
              <ModeSwitch mode="serve" fullWidth />
              <BottomTabBar mode="serve" current="chat" embedded />
            </div>
          </div>
          <Cap>
            The segmented mode switch sits at the top of main; the tab bar is fixed at the bottom on
            phones.
          </Cap>
        </Block>

        <div className="grid grid-cols-2 gap-5 max-md:grid-cols-1">
          <Block id="g-form" title="Form controls">
            <TextField label="Email address" defaultValue="demo@example.invalid" type="email" />
            <TextField
              label="Email address, focused"
              defaultValue="demo@exam"
              autoFocus={false}
              className="border-service-blue"
            />
            <TextField
              label="6-digit code"
              defaultValue="12345"
              error="Enter all 6 digits."
              helper="You can paste the whole code at once."
            />
            <TextArea
              label="Where should the helper meet you?"
              helper="A place or cross street. Shown only to the helper who accepts."
              maxLength={200}
            />
            <Select
              label="County"
              placeholder="Choose a county"
              options={[
                { value: 'SANTA_CLARA', label: 'Santa Clara' },
                { value: 'ALAMEDA', label: 'Alameda' },
              ]}
            />
          </Block>
          <Block id="g-choice" title="Choice cards">
            <RadioCardGroup
              legend="One answer per question, whole card is the target"
              name="gallery-choice"
              value={role}
              onValueChange={setRole}
              options={[
                { value: 'well', title: 'Well connected' },
                { value: 'somewhat', title: 'Somewhat connected' },
                {
                  value: 'barely',
                  title: 'Barely connected',
                  description: 'Selected = ink border plus inset.',
                },
              ]}
            />
          </Block>
        </div>

        <Block id="g-progress" title="Stepper and progress">
          <Stepper
            label="Verification steps"
            steps={['Start verification', 'Wait for the result', "You're in"]}
            current={1}
          />
          <Card padding="xl">
            <ProgressTrack
              label="Request progress"
              steps={[
                { label: 'Request received', detail: '7:42 PM', state: 'done' },
                { label: 'Looking for a veteran', detail: 'Now', state: 'now' },
                { label: 'A veteran was notified', detail: 'Not yet', state: 'todo' },
                { label: 'A veteran accepted', detail: 'Not yet', state: 'todo' },
              ]}
            />
          </Card>
          <Cap>The beacon pulses only when the person allows motion.</Cap>
        </Block>

        <Block id="g-card" title="Card and dialog">
          <div className="grid grid-cols-3 gap-5 max-md:grid-cols-1">
            <Card>
              <p className="font-bold">Card</p>
              <p className="text-slate">White, Line hairline, 12 px radius, no shadow.</p>
            </Card>
            <Card emphasis>
              <p className="font-bold">Emphasis card</p>
              <p className="text-slate">2 px ink border for the one card that matters.</p>
            </Card>
            <Card padding="none" className="grid place-items-center p-6">
              <Button variant="secondary" onClick={() => setDialogOpen(true)}>
                Open dialog
              </Button>
            </Card>
          </div>
          <Dialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            title="Cancel this request?"
          >
            <p>You can send a new request any time.</p>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => setDialogOpen(false)}>Keep request</Button>
              <Button variant="secondary" onClick={() => setDialogOpen(false)}>
                Cancel request
              </Button>
            </div>
          </Dialog>
        </Block>

        <Block id="g-tiles" title="Need cards and the QRF panel">
          <div className="grid grid-cols-4 gap-3.5 max-md:grid-cols-2 max-sm:grid-cols-2">
            <NeedTile
              category="SHELTER"
              to="#g-tiles"
              description="Temporary shelter. Long-term housing placement is not available yet."
            />
            <NeedTile
              category="FOOD"
              to="#g-tiles"
              description="Pantries, meals and essential supplies."
            />
            <NeedTile
              category="TRANSPORTATION"
              to="#g-tiles"
              description="Rides to appointments and errands."
            />
            <NeedTileOff
              icon={BriefcaseIcon}
              title="Job Training"
              status="Coming soon"
              description="Not available yet. This does not create a request."
              to="#g-tiles"
            />
          </div>
          <div className="grid grid-cols-3 gap-3.5 max-md:grid-cols-1">
            <NeedTile category="SHELTER" to="#g-tiles" appearance="row" />
            <NeedTile category="FOOD" to="#g-tiles" appearance="row" />
            <NeedTile category="PEER_SUPPORT" to="#g-tiles" appearance="row" />
          </div>
          <div className="grid grid-cols-3 gap-3.5 max-md:grid-cols-1">
            <NeedTileOff
              icon={ChatIcon}
              title="Counseling"
              status="Coming soon"
              description="Not available yet. This does not create a request."
              to="#g-tiles"
            />
            <NeedTileOff
              icon={FlagIcon}
              title="Activities"
              status="Info only"
              description="Community listings only. This does not create a request."
              to="#g-tiles"
            />
          </div>
          <QrfPanel href="#g-tiles" />
        </Block>

        <Block id="g-crisis" title="Crisis strip, panel and footer">
          <div className="overflow-hidden rounded-10">
            <CrisisStrip />
          </div>
          <div className="grid grid-cols-2 gap-5 max-md:grid-cols-1">
            <CrisisPanel />
            <CrisisPanel layout="full" />
          </div>
          <div className="rounded-10 border border-line">
            <Footer showVeteransCrisisLine />
          </div>
          <Cap>
            The wording is the released D-012 copy, restyled but never rewritten. 911 and 988 are
            always SOS red. SOS buttons keep a 2 px white edge, and never flash, pulse or auto-dial.
            The Veterans Crisis Line line shows on Landing only.
          </Cap>
        </Block>

        <Block id="g-admin" title="Admin layout">
          <div className="overflow-hidden rounded-10 border border-line">
            <AdminLayout
              embedded
              scope="Scope: Santa Clara pilot tenant. Synthetic staging."
              onSignOut={noop}
              nav={[
                { label: 'Overview', to: '#g-admin', current: true },
                { label: 'Resource drafts', to: '#g-admin' },
                { label: 'Platform operations', to: '#g-admin', soon: true },
              ]}
            >
              <h1 className="heading text-40">Overview</h1>
              <Card>Admin content area on Mist.</Card>
            </AdminLayout>
          </div>
        </Block>

        <Block id="g-icons" title="Icons">
          <Row>
            {[
              HomeIcon,
              ChatIcon,
              PhoneIcon,
              UsersIcon,
              CarIcon,
              SoupIcon,
              HouseIcon,
              FlagIcon,
              BriefcaseIcon,
              ArrowRightIcon,
              ChevronRightIcon,
              CheckIcon,
              XIcon,
              AlertTriangleIcon,
              LockIcon,
              MapPinIcon,
              MailIcon,
              SendIcon,
            ].map((Glyph, index) => (
              <span
                key={index}
                className="grid size-12 place-items-center rounded-10 border border-line"
              >
                <Glyph />
              </span>
            ))}
          </Row>
          <Cap>Lucide-style line icons, 22 px, stroke 2.</Cap>
        </Block>
      </div>
    </div>
  );
}
