#!/usr/bin/env perl
# patch-main.pl — apply our (tiny) patches to the upstream web client bundle.
#
#     perl patch-main.pl <input.js> <output.js>
#
# Called by ./prepare-client.sh after it extracts the bundle from the pinned
# Docker image. Perl (not Node) on purpose: the repo already depends on it for
# in-place edits, and the host only needs Docker + perl to run this project.
#
# Every patch is a targeted replacement that is verified; the script EXITS
# NON-ZERO if the upstream code shape changed, so bumping the image digest can
# never silently ship a client with a half-applied patch.
#
# Patches
#   1. window.__xash — expose the engine instance. web/index.html's map picker
#      and web/join.js use it to run console commands (`connect`, `rcon
#      changelevel`, `map`, ...). Without it nothing in our UI can talk to the
#      engine, and joining the server is impossible.
#   2. window.__csPeer — let the player override the address that incoming
#      WebRTC packets are attributed to. Upstream hardcodes 127.0.0.1:8080
#      (correct for the stock single-container layout, and still the default),
#      so this is only a safety valve if the networking layout changes.
use strict;
use warnings;

my ($in, $out) = @ARGV;
die "usage: patch-main.pl <in.js> <out.js>\n" unless defined $in && defined $out;

open(my $fh, '<', $in) or die "cannot read $in: $!\n";
my $src = do { local $/; <$fh> };
close $fh;

my @report;
my @failures;

# --- 1. expose the engine instance -----------------------------------------
my $new = '=window.__xash=new Xash3DWebRTC(';
my $already = () = $src =~ /\Q$new\E/g;
if ($already > 0) {
    push @report, 'expose engine as window.__xash: already patched';
} else {
    my $n = ($src =~ s/\=new Xash3DWebRTC\(/$new/g) || 0;
    if ($n > 0) {
        push @report, "expose engine as window.__xash: $n site(s) patched";
    } else {
        push @failures, "could not find '=new Xash3DWebRTC(' (engine construction)";
    }
}

# --- 2. overridable remote address for incoming packets --------------------
# Upstream shape: {ip:[127,0,0,1],port:8080,data:...}
if ($src =~ /window\.__csPeer\|\|\[127,0,0,1\]/) {
    push @report, 'overridable packet source: already patched';
} elsif ($src =~ /ip:\s*\[\s*127\s*,\s*0\s*,\s*0\s*,\s*1\s*\](\s*,\s*port:\s*)(\d+)/) {
    my ($sep, $port) = ($1, $2);
    $src =~ s/ip:\s*\[\s*127\s*,\s*0\s*,\s*0\s*,\s*1\s*\](\s*,\s*port:\s*)(\d+)/
              'ip:(window.__csPeer||[127,0,0,1])' . $sep . '(window.__csPeer?window.__csPeer[4]:' . $port . ')'/e;
    push @report, 'overridable packet source (window.__csPeer): 1 site patched';
} else {
    # Not fatal: joining does not depend on it (the stock layout is correct).
    push @report, 'overridable packet source: upstream shape not found — skipped (not required)';
}

if (@failures) {
    print STDERR "PATCH FAILED:\n";
    print STDERR "  - $_\n" for @failures;
    print STDERR "The upstream bundle changed shape. Inspect it and update patch-main.pl.\n";
    exit 1;
}

open(my $ofh, '>', $out) or die "cannot write $out: $!\n";
print $ofh $src;
close $ofh;

print "  $_\n" for @report;
exit 0;
